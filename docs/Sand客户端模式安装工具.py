"""交互式运行：
    python "Sand客户端模式安装工具.py"

命令行运行：
    python "Sand客户端模式安装工具.py" install
    python "Sand客户端模式安装工具.py" uninstall
    python "Sand客户端模式安装工具.py" set-path <Cursor路径|auto>
"""

from __future__ import annotations

import argparse
import base64
import ctypes
import hashlib
import json
import os
import re
import shutil
import signal
import stat
import subprocess
import sys
import threading
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, Iterable, List, Mapping, Optional, Sequence, Set, Tuple, Union


TOOL_VERSION = "1.0.1"
CONFIG_VERSION = 1

SAND_CLIENT_MARKER = "/*SAND_CLIENT_MODE_V1*/"
SAND_CLIENT_EXISTING_MARKER = "/*SAND_CLIENT_EXISTING_V1*/"
SAND_ELIGIBILITY_MARKER = "/*SAND_ELIGIBILITY_MODE_V1*/"
LEGACY_SAND_CLIENT_MARKER = "/*K" + "C_SAND_CLIENT_V1*/"
LEGACY_SAND_ELIGIBILITY_MARKER = "/*K" + "C_SAND_ELIGIBILITY_V1*/"
CLIENT_MARKER_PATTERN = re.escape(SAND_CLIENT_MARKER)
CLIENT_EXISTING_MARKER_PATTERN = re.escape(SAND_CLIENT_EXISTING_MARKER)
ELIGIBILITY_MARKER_PATTERN = re.escape(SAND_ELIGIBILITY_MARKER)
LEGACY_CLIENT_MARKER_PATTERN = re.escape(LEGACY_SAND_CLIENT_MARKER)
LEGACY_ELIGIBILITY_MARKER_PATTERN = re.escape(LEGACY_SAND_ELIGIBILITY_MARKER)
CLIENT_MARKER_GUARD_PATTERN = r"/\*[A-Z0-9_]*SAND_CLIENT(?:_(?:MODE|EXISTING))?_V1\*/"
ELIGIBILITY_MARKER_GUARD_PATTERN = r"/\*[A-Z0-9_]*SAND_ELIGIBILITY(?:_MODE)?_V1\*/"
SAND_ONBOARDING_URL = "https://cursor.com/bot/onboarding?product=grok-bot"

ANSI_RESET = "\033[0m"
ANSI_BOLD = "\033[1m"
ANSI_RED = "\033[31m"
ANSI_GREEN = "\033[32m"
ANSI_YELLOW = "\033[33m"
ANSI_BLUE = "\033[36m"

_COLOR_ENABLED = True


TARGET_SPECS: Tuple[Tuple[str, Optional[str]], ...] = (
    ("out/main.js", None),
    ("out/vs/workbench/api/worker/extensionHostWorkerMain.js", None),
    ("out/vs/workbench/api/node/extensionHostProcess.js", None),
    ("out/vs/workbench/workbench.glass.main.js", None),
    ("out/vs/workbench/workbench.desktop.main.js", None),
    ("extensions/cursor-always-local/dist/main.js", "cursor-always-local"),
    (
        "extensions/cursor-local-agent-runtime/dist/main.js",
        "cursor-local-agent-runtime",
    ),
    ("extensions/cursor-agent-host/dist/main.js", "cursor-agent-host"),
    ("extensions/cursor-agent-exec/dist/main.js", "cursor-agent-exec"),
)

EXT_HOST_REL = "out/vs/workbench/api/node/extensionHostProcess.js"

ELIGIBILITY_PREFIXES: Tuple[str, ...] = (
    "function r4g(e){const{adminSettingsService:t",
    "function Vj_(t){const{adminSettingsService:e",
    "function inf(e){const{adminSettingsService:t",
    "function HSy(t){const{adminSettingsService:e",
    "function Q_f(e){const{adminSettingsService:t",
    "function BpS(t){const{adminSettingsService:e",
)


class SandToolError(RuntimeError):
    pass


@dataclass(frozen=True)
class CursorLayout:
    install_root: Path
    app_root: Path
    product_json: Path
    executable: Path
    target_paths: Tuple[Path, ...]
    ext_host_path: Optional[Path]
    version: str


@dataclass(frozen=True)
class PlannedFile:
    original: bytes
    next_bytes: bytes
    mode: int


@dataclass
class PatchStats:
    is_glass: int = 0
    object_header: int = 0
    set_header: int = 0
    eligibility: int = 0
    adopted_sand: int = 0
    migrated_client: int = 0
    migrated_eligibility: int = 0

    @property
    def total(self) -> int:
        return (
            self.is_glass
            + self.object_header
            + self.set_header
            + self.eligibility
            + self.migrated_client
            + self.migrated_eligibility
        )


@dataclass
class RemoveStats:
    client_type: int = 0
    eligibility: int = 0

    @property
    def total(self) -> int:
        return self.client_type + self.eligibility


@dataclass(frozen=True)
class PatchStatus:
    client_markers: int
    eligibility_markers: int
    ide_matches: int
    external_sand_matches: int
    external_marker_count: int
    legacy_client_markers: int
    legacy_eligibility_markers: int
    patched_files: Tuple[Path, ...]

    @property
    def installed(self) -> bool:
        return (
            self.client_markers
            + self.eligibility_markers
            + self.legacy_client_markers
            + self.legacy_eligibility_markers
            > 0
        )


def _compile_client_rules() -> Tuple[Tuple[str, re.Pattern[str]], ...]:
    marker_guard = rf"(?!{CLIENT_MARKER_GUARD_PATTERN})"
    return (
        (
            "is_glass",
            re.compile(
                rf"(isGlass\s*\?\s*[\"']glass[\"']\s*:\s*)([\"'])(ide|sand)\2{marker_guard}"
            ),
        ),
        (
            "object_header",
            re.compile(
                rf"([\"']x-cursor-client-type[\"']\s*:\s*)([\"'])(ide|sand)\2{marker_guard}"
            ),
        ),
        (
            "set_header",
            re.compile(
                rf"(header\.set\(\s*[\"']x-cursor-client-type[\"']\s*,\s*"
                rf"[A-Za-z_$][A-Za-z0-9_$.]*\s*(?:\?\?|\|\|)\s*)"
                rf"([\"'])(ide|sand)\2{marker_guard}"
            ),
        ),
    )


CLIENT_RULES = _compile_client_rules()


def _platform_name() -> str:
    if sys.platform == "win32":
        return "windows"
    if sys.platform == "darwin":
        return "macos"
    raise SandToolError("当前仅支持 Windows 和 macOS")


def _enable_windows_ansi() -> bool:
    if sys.platform != "win32":
        return True
    try:
        kernel32 = ctypes.windll.kernel32
        for handle_id in (-11, -12):
            handle = kernel32.GetStdHandle(handle_id)
            if handle in (0, -1):
                continue
            mode = ctypes.c_uint32()
            if not kernel32.GetConsoleMode(handle, ctypes.byref(mode)):
                continue
            kernel32.SetConsoleMode(handle, mode.value | 0x0004)
        return True
    except Exception:
        return False


def _configure_console() -> None:
    global _COLOR_ENABLED
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if callable(reconfigure):
            try:
                reconfigure(encoding="utf-8", errors="replace")
            except Exception:
                pass
    if os.environ.get("NO_COLOR"):
        _COLOR_ENABLED = False
        return
    _COLOR_ENABLED = _enable_windows_ansi() and sys.stdout.isatty()


def colorize(text: str, *codes: str) -> str:
    if not _COLOR_ENABLED or not codes:
        return text
    return "".join(codes) + text + ANSI_RESET


def print_warn(text: str) -> None:
    print(colorize(text, ANSI_YELLOW))


def print_error(text: str) -> None:
    print(colorize(text, ANSI_RED), file=sys.stderr)


class LoadingSpinner:
    def __init__(self, message: str = "处理中") -> None:
        self.message = message
        self._stop = threading.Event()
        self._thread: Optional[threading.Thread] = None

    def __enter__(self) -> "LoadingSpinner":
        if sys.stdout.isatty():
            self._thread = threading.Thread(target=self._run, daemon=True)
            self._thread.start()
        else:
            print(colorize(self.message + "...", ANSI_BLUE), flush=True)
        return self

    def __exit__(self, *_exc: object) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join()
            print("\r" + " " * 48 + "\r", end="", flush=True)

    def _run(self) -> None:
        frames = ("|", "/", "-", "\\")
        index = 0
        while not self._stop.wait(0.1):
            text = f"{frames[index % 4]} {self.message}"
            print("\r" + colorize(text, ANSI_BLUE), end="", flush=True)
            index += 1


def _config_dir() -> Path:
    if sys.platform == "win32":
        base = os.environ.get("LOCALAPPDATA") or os.environ.get("APPDATA")
        if base:
            return Path(base) / "SandClientMode" / "sand-client-cli"
        return Path.home() / "AppData" / "Local" / "SandClientMode" / "sand-client-cli"
    if sys.platform == "darwin":
        return (
            Path.home()
            / "Library"
            / "Application Support"
            / "SandClientMode"
            / "sand-client-cli"
        )
    return Path.home() / ".config" / "SandClientMode" / "sand-client-cli"


def _config_path() -> Path:
    return _config_dir() / "config.json"


def _is_within(path: Path, root: Path) -> bool:
    try:
        path.relative_to(root)
        return True
    except ValueError:
        return False


def _path_key(path: Path) -> str:
    normalized = str(path.resolve())
    return os.path.normcase(normalized)


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _product_checksum(data: bytes) -> str:
    digest = hashlib.sha256(data).digest()
    return base64.b64encode(digest).decode("ascii").rstrip("=")


def _atomic_write(path: Path, data: bytes, mode: Optional[int] = None) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.parent / (
        f".{path.name}.sand-client-{os.getpid()}-{time.time_ns()}.tmp"
    )
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    fd: Optional[int] = None
    try:
        fd = os.open(str(temp), flags, 0o600)
        with os.fdopen(fd, "wb", closefd=True) as handle:
            fd = None
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        if mode is not None:
            os.chmod(temp, stat.S_IMODE(mode))
        try:
            os.replace(temp, path)
        except PermissionError:
            original_mode: Optional[int] = None
            if path.exists():
                original_mode = stat.S_IMODE(path.stat().st_mode)
                os.chmod(path, original_mode | stat.S_IWRITE)
            try:
                os.replace(temp, path)
            except BaseException:
                if original_mode is not None and path.exists():
                    try:
                        os.chmod(path, original_mode)
                    except OSError:
                        pass
                raise
        if mode is not None:
            os.chmod(path, stat.S_IMODE(mode))
    finally:
        if fd is not None:
            os.close(fd)
        try:
            if temp.exists():
                temp.unlink()
        except OSError:
            pass


def _write_json_atomic(path: Path, value: Mapping[str, object]) -> None:
    data = (json.dumps(value, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
    _atomic_write(path, data, 0o600)


def _load_config() -> Mapping[str, object]:
    path = _config_path()
    if not path.exists():
        return {}
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:
        raise SandToolError(
            f"配置文件损坏：{path}\n请运行 set-path auto 后重新检测"
        ) from exc
    if not isinstance(value, dict) or value.get("version") != CONFIG_VERSION:
        raise SandToolError(
            f"不支持的配置文件：{path}\n请运行 set-path auto 后重新检测"
        )
    return value


def _read_product(product_path: Path) -> Mapping[str, object]:
    try:
        size = product_path.stat().st_size
        if size <= 0 or size > 1024 * 1024:
            raise SandToolError(f"product.json 大小异常：{product_path}")
        raw = product_path.read_bytes()
        value = json.loads(raw.decode("utf-8-sig"))
    except SandToolError:
        raise
    except Exception as exc:
        raise SandToolError(f"无法读取 Cursor product.json：{product_path}") from exc
    if not isinstance(value, dict):
        raise SandToolError(f"Cursor product.json 格式错误：{product_path}")
    name = str(value.get("applicationName") or value.get("nameShort") or "")
    if name.casefold() != "cursor":
        raise SandToolError(f"所选目录不是 Cursor 安装：{product_path}")
    return value


def _find_app_bundle(app_root: Path) -> Optional[Path]:
    for item in (app_root, *app_root.parents):
        if item.name.casefold() == "cursor.app":
            return item
    return None


def _candidate_app_roots(raw_path: Path) -> Iterable[Path]:
    path = raw_path
    if path.is_file():
        if path.name.casefold() == "product.json":
            path = path.parent
        else:
            path = path.parent
    current = path
    for _ in range(8):
        yield current
        yield current / "resources" / "app"
        yield current / "Resources" / "app"
        yield current / "Contents" / "Resources" / "app"
        if current.parent == current:
            break
        current = current.parent


def _resolve_executable(app_root: Path) -> Tuple[Path, Path]:
    if sys.platform == "win32":
        if app_root.parent.name.casefold() == "resources":
            install_root = app_root.parent.parent
        else:
            install_root = app_root
        candidates = (
            install_root / "Cursor.exe",
            install_root / "cursor.exe",
        )
    elif sys.platform == "darwin":
        bundle = _find_app_bundle(app_root)
        if bundle is None:
            raise SandToolError("macOS Cursor 路径必须位于 Cursor.app 内")
        install_root = bundle
        candidates = (bundle / "Contents" / "MacOS" / "Cursor",)
    else:
        raise SandToolError("当前仅支持 Windows 和 macOS")

    for executable in candidates:
        try:
            resolved = executable.resolve(strict=True)
        except (FileNotFoundError, OSError):
            continue
        if resolved.is_file() and _is_within(resolved, install_root.resolve()):
            return install_root.resolve(), resolved
    raise SandToolError(f"未找到 Cursor 可执行文件：{install_root}")


def layout_from_path(value: Union[str, Path]) -> CursorLayout:
    raw_text = str(value).strip().strip('"')
    if not raw_text:
        raise SandToolError("Cursor 路径不能为空")
    if sys.platform == "win32" and (
        raw_text.startswith("\\\\") or raw_text.startswith("\\\\?\\")
    ):
        raise SandToolError("不支持 UNC 或 Windows 设备路径")

    raw = Path(raw_text).expanduser()
    if not raw.is_absolute():
        raise SandToolError(f"Cursor 路径必须是绝对路径：{raw}")
    try:
        raw = raw.resolve(strict=True)
    except (FileNotFoundError, OSError) as exc:
        raise SandToolError(f"Cursor 路径不存在：{raw}") from exc

    seen: Set[str] = set()
    last_error: Optional[Exception] = None
    for candidate in _candidate_app_roots(raw):
        try:
            app_root = candidate.resolve(strict=True)
        except (FileNotFoundError, OSError):
            continue
        key = _path_key(app_root)
        if key in seen:
            continue
        seen.add(key)

        product_json = app_root / "product.json"
        if not product_json.is_file():
            continue
        try:
            product_real = product_json.resolve(strict=True)
            if not _is_within(product_real, app_root):
                raise SandToolError("product.json 符号链接逃逸出 Cursor app 目录")
            product = _read_product(product_real)
            install_root, executable = _resolve_executable(app_root)

            targets: List[Path] = []
            for rel, _extension_name in TARGET_SPECS:
                target = app_root.joinpath(*rel.split("/"))
                if not target.is_file():
                    continue
                target_real = target.resolve(strict=True)
                if not _is_within(target_real, app_root):
                    raise SandToolError(f"目标文件符号链接逃逸：{target}")
                targets.append(target_real)
            if not targets:
                raise SandToolError(
                    "Cursor 使用 app.asar 或当前版本没有可识别的 Sand 目标文件"
                )

            ext_host = app_root.joinpath(*EXT_HOST_REL.split("/"))
            ext_host_real = ext_host.resolve(strict=True) if ext_host.is_file() else None
            version = str(product.get("version") or product.get("commit") or "未知")
            return CursorLayout(
                install_root=install_root,
                app_root=app_root,
                product_json=product_real,
                executable=executable,
                target_paths=tuple(targets),
                ext_host_path=ext_host_real,
                version=version,
            )
        except SandToolError as exc:
            last_error = exc
            continue

    if last_error:
        raise SandToolError(f"Cursor 路径校验失败：{last_error}") from last_error
    raise SandToolError(f"路径中未找到 Cursor resources/app：{raw}")


def _powershell_executable() -> Optional[str]:
    return shutil.which("powershell.exe") or shutil.which("powershell") or shutil.which("pwsh")


def _windows_running_candidates() -> List[str]:
    powershell = _powershell_executable()
    if not powershell:
        return []
    script = (
        "$ErrorActionPreference='SilentlyContinue';"
        "[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new();"
        "Get-CimInstance Win32_Process -Filter \"Name='Cursor.exe'\" | "
        "ForEach-Object { if ($_.ExecutablePath) { $_.ExecutablePath } }"
    )
    try:
        result = subprocess.run(
            [powershell, "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=15,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return []
    if result.returncode != 0:
        return []
    return [line.strip() for line in result.stdout.splitlines() if line.strip()]


def _windows_registry_candidates() -> List[str]:
    if sys.platform != "win32":
        return []
    try:
        import winreg
    except ImportError:
        return []

    candidates: List[str] = []
    roots = (winreg.HKEY_CURRENT_USER, winreg.HKEY_LOCAL_MACHINE)
    views = (winreg.KEY_WOW64_64KEY, winreg.KEY_WOW64_32KEY)
    uninstall = r"Software\Microsoft\Windows\CurrentVersion\Uninstall"
    for root in roots:
        for view in views:
            try:
                parent = winreg.OpenKey(root, uninstall, 0, winreg.KEY_READ | view)
            except OSError:
                continue
            with parent:
                index = 0
                while True:
                    try:
                        name = winreg.EnumKey(parent, index)
                    except OSError:
                        break
                    index += 1
                    try:
                        child = winreg.OpenKey(parent, name)
                    except OSError:
                        continue
                    with child:
                        def read(name_: str) -> str:
                            try:
                                return str(winreg.QueryValueEx(child, name_)[0] or "")
                            except OSError:
                                return ""

                        display_name = read("DisplayName").strip()
                        publisher = read("Publisher").strip()
                        if display_name.casefold() != "cursor" and "anysphere" not in publisher.casefold():
                            continue
                        install_location = read("InstallLocation").strip().strip('"')
                        display_icon = read("DisplayIcon").strip().strip('"')
                        if install_location:
                            candidates.append(install_location)
                        if display_icon:
                            icon_path = re.sub(r",\s*-?\d+$", "", display_icon).strip('"')
                            candidates.append(icon_path)
    return candidates


def _mac_process_paths(strict: bool = False) -> List[Tuple[int, Path]]:
    try:
        libproc = ctypes.CDLL("/usr/lib/libproc.dylib")
        proc_pidpath = libproc.proc_pidpath
        proc_pidpath.argtypes = [ctypes.c_int, ctypes.c_void_p, ctypes.c_uint32]
        proc_pidpath.restype = ctypes.c_int
        result = subprocess.run(
            ["ps", "-axo", "pid="],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=10,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        if strict:
            raise SandToolError("无法读取 macOS 进程可执行路径") from exc
        return []
    if result.returncode != 0:
        if strict:
            raise SandToolError("无法读取 macOS 进程可执行路径")
        return []
    values: List[Tuple[int, Path]] = []
    for line in result.stdout.splitlines():
        try:
            pid = int(line.strip())
        except ValueError:
            continue
        buffer = ctypes.create_string_buffer(4096)
        length = proc_pidpath(pid, buffer, len(buffer))
        if length <= 0:
            continue
        try:
            executable = Path(os.fsdecode(buffer.value)).resolve(strict=False)
        except (OSError, ValueError):
            continue
        values.append((pid, executable))
    return values


def _bundle_for_executable(executable: Path) -> Optional[Path]:
    for item in (executable, *executable.parents):
        if item.name.casefold() == "cursor.app":
            return item
    return None


def _mac_running_candidates() -> List[str]:
    values: Dict[str, str] = {}
    for _pid, executable in _mac_process_paths():
        bundle = _bundle_for_executable(executable)
        if bundle is not None:
            values.setdefault(_path_key(bundle), str(bundle))
    return list(values.values())


def _mac_spotlight_candidates() -> List[str]:
    mdfind = shutil.which("mdfind")
    if not mdfind:
        return []
    try:
        result = subprocess.run(
            [
                mdfind,
                "kMDItemCFBundleIdentifier == 'com.todesktop.230313mzl4w4u92'",
            ],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=15,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return []
    if result.returncode != 0:
        return []
    return [line.strip() for line in result.stdout.splitlines() if line.strip()]


def _default_candidate_groups() -> Iterable[Tuple[str, Sequence[str]]]:
    env_candidate = os.environ.get("SAND_CURSOR_INSTALL_DIR", "").strip()
    if env_candidate:
        yield "环境变量 SAND_CURSOR_INSTALL_DIR", (env_candidate,)

    if sys.platform == "win32":
        yield "运行中的 Cursor", _windows_running_candidates()
        yield "Windows 安装登记", _windows_registry_candidates()
        local = os.environ.get("LOCALAPPDATA", "")
        program_files = os.environ.get("ProgramFiles", r"C:\Program Files")
        program_files_x86 = os.environ.get("ProgramFiles(x86)", "")
        defaults = [
            str(Path(local) / "Programs" / "Cursor") if local else "",
            str(Path(local) / "Programs" / "cursor") if local else "",
            str(Path(local) / "Cursor") if local else "",
            str(Path(program_files) / "Cursor"),
            str(Path(program_files_x86) / "Cursor") if program_files_x86 else "",
        ]
        yield "Windows 默认目录", tuple(x for x in defaults if x)
    elif sys.platform == "darwin":
        yield "运行中的 Cursor", _mac_running_candidates()
        yield "macOS Spotlight", _mac_spotlight_candidates()
        yield "macOS 默认目录", (
            "/Applications/Cursor.app",
            str(Path.home() / "Applications" / "Cursor.app"),
        )

    path_cursor = shutil.which("cursor")
    if path_cursor:
        yield "PATH", (path_cursor,)


def _valid_layouts(values: Sequence[str]) -> List[CursorLayout]:
    layouts: Dict[str, CursorLayout] = {}
    for value in values:
        if not value:
            continue
        try:
            layout = layout_from_path(value)
        except SandToolError:
            continue
        layouts.setdefault(_path_key(layout.app_root), layout)
    return list(layouts.values())


def resolve_cursor_layout() -> CursorLayout:
    configured = _load_config().get("cursorInstallRoot")
    if isinstance(configured, str) and configured.strip():
        try:
            return layout_from_path(configured)
        except SandToolError as exc:
            raise SandToolError(
                f"已设置的 Cursor 路径失效：{configured}\n"
                "请运行 set-path <新路径>，或运行 set-path auto 恢复自动检测"
            ) from exc

    for source, values in _default_candidate_groups():
        layouts = _valid_layouts(tuple(values))
        if len(layouts) == 1:
            return layouts[0]
        if len(layouts) > 1:
            options = "\n".join(f"  - {item.install_root}" for item in layouts)
            raise SandToolError(
                f"{source}检测到多个 Cursor 安装，请先在菜单中选择 3 设置路径：\n{options}"
            )
    raise SandToolError(
        "未检测到 Cursor 安装，请在菜单中选择 3 设置 Cursor 路径"
        "（Cursor.exe、Cursor.app 或 resources/app）"
    )


def save_cursor_path(value: str) -> Optional[CursorLayout]:
    if value.strip().casefold() in {"auto", "clear", "reset"}:
        _write_json_atomic(
            _config_path(),
            {
                "version": CONFIG_VERSION,
                "cursorInstallRoot": "",
                "lastVerifiedVersion": "",
                "updatedAt": datetime.now(timezone.utc).isoformat(),
            },
        )
        return None

    layout = layout_from_path(value)
    _write_json_atomic(
        _config_path(),
        {
            "version": CONFIG_VERSION,
            "cursorInstallRoot": str(layout.install_root),
            "lastVerifiedVersion": layout.version,
            "updatedAt": datetime.now(timezone.utc).isoformat(),
        },
    )
    return layout


def apply_patch_to_content(content: str) -> Tuple[str, PatchStats]:
    stats = PatchStats()
    next_content = content
    legacy_client_re = re.compile(
        rf"([\"'])sand\1{LEGACY_CLIENT_MARKER_PATTERN}"
    )
    next_content, stats.migrated_client = legacy_client_re.subn(
        lambda match: match.group(1)
        + "sand"
        + match.group(1)
        + SAND_CLIENT_MARKER,
        next_content,
    )
    legacy_eligibility = "return!1;" + LEGACY_SAND_ELIGIBILITY_MARKER
    stats.migrated_eligibility = next_content.count(legacy_eligibility)
    next_content = next_content.replace(
        legacy_eligibility,
        "return!1;" + SAND_ELIGIBILITY_MARKER,
    )
    for key, rule in CLIENT_RULES:
        def replace_client(match: re.Match[str], stat_key: str = key) -> str:
            current = match.group(3)
            setattr(stats, stat_key, getattr(stats, stat_key) + 1)
            if current == "sand":
                stats.adopted_sand += 1
                marker = SAND_CLIENT_EXISTING_MARKER
            else:
                marker = SAND_CLIENT_MARKER
            return (
                match.group(1)
                + match.group(2)
                + "sand"
                + match.group(2)
                + marker
            )

        next_content = rule.sub(replace_client, next_content)

    for prefix in ELIGIBILITY_PREFIXES:
        count = next_content.count(prefix)
        if count == 0:
            continue
        patched = prefix.replace(
            "{const{adminSettingsService:",
            "{return!1;" + SAND_ELIGIBILITY_MARKER + "const{adminSettingsService:",
        )
        next_content = next_content.replace(prefix, patched)
        stats.eligibility += count
    return next_content, stats


def remove_patch_from_content(content: str) -> Tuple[str, RemoveStats]:
    stats = RemoveStats()
    legacy_client_re = re.compile(
        rf"([\"'])sand\1{LEGACY_CLIENT_MARKER_PATTERN}"
    )
    next_content, legacy_client_count = legacy_client_re.subn(
        lambda match: match.group(1) + "ide" + match.group(1),
        content,
    )
    stats.client_type += legacy_client_count
    legacy_eligibility = "return!1;" + LEGACY_SAND_ELIGIBILITY_MARKER
    legacy_eligibility_count = next_content.count(legacy_eligibility)
    next_content = next_content.replace(legacy_eligibility, "")
    stats.eligibility += legacy_eligibility_count
    client_re = re.compile(rf"([\"'])sand\1{CLIENT_MARKER_PATTERN}")
    existing_re = re.compile(
        rf"([\"'])sand\1{CLIENT_EXISTING_MARKER_PATTERN}"
    )

    def remove_client(match: re.Match[str]) -> str:
        stats.client_type += 1
        return match.group(1) + "ide" + match.group(1)

    next_content = client_re.sub(remove_client, next_content)
    next_content, existing_count = existing_re.subn(
        lambda match: match.group(1) + "sand" + match.group(1),
        next_content,
    )
    stats.client_type += existing_count
    eligibility_re = re.compile(rf"return!1;{ELIGIBILITY_MARKER_PATTERN}")
    next_content, eligibility_count = eligibility_re.subn("", next_content)
    stats.eligibility += eligibility_count
    return next_content, stats


def _decode_js(data: bytes, path: Path) -> str:
    try:
        return data.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise SandToolError(f"目标文件不是 UTF-8，拒绝修改：{path}") from exc


def _read_planned_file(path: Path) -> PlannedFile:
    original = path.read_bytes()
    return PlannedFile(
        original=original,
        next_bytes=original,
        mode=stat.S_IMODE(path.stat().st_mode),
    )


def _target_extension_name(layout: CursorLayout, file_path: Path) -> Optional[str]:
    for rel, extension_name in TARGET_SPECS:
        if not extension_name:
            continue
        candidate = layout.app_root.joinpath(*rel.split("/")).resolve()
        if candidate == file_path.resolve():
            return extension_name
    return None


def _update_extension_hashes(
    layout: CursorLayout,
    plan: Dict[Path, PlannedFile],
) -> None:
    changed_extensions: List[Tuple[str, bytes]] = []
    for file_path, planned in plan.items():
        extension_name = _target_extension_name(layout, file_path)
        if extension_name:
            changed_extensions.append((extension_name, planned.next_bytes))
    if not changed_extensions or layout.ext_host_path is None:
        return

    ext_path = layout.ext_host_path
    existing = plan.get(ext_path) or _read_planned_file(ext_path)
    next_content = _decode_js(existing.next_bytes, ext_path)
    original_content = _decode_js(existing.original, ext_path)

    for extension_name, next_main in changed_extensions:
        extension_id = "anysphere." + extension_name
        if f'"{extension_id}"' not in next_content:
            continue
        digest = hashlib.sha256(next_main).hexdigest()
        pattern = re.compile(
            rf'(\"{re.escape(extension_id)}\"\s*:\s*\{{[\s\S]{{0,2400}}?'
            rf'\"main\.js\"\s*:\s*\")[0-9a-f]{{64}}(\")'
        )
        next_content, count = pattern.subn(
            lambda match: match.group(1) + digest + match.group(2),
            next_content,
            count=1,
        )
        if count != 1:
            raise SandToolError(f"无法定位 {extension_id} 的内嵌 main.js 哈希")

    if next_content != original_content:
        plan[ext_path] = PlannedFile(
            original=existing.original,
            next_bytes=next_content.encode("utf-8"),
            mode=existing.mode,
        )


def _sync_product_checksums(
    layout: CursorLayout,
    plan: Dict[Path, PlannedFile],
) -> None:
    product_file = _read_planned_file(layout.product_json)
    has_bom = product_file.original.startswith(b"\xef\xbb\xbf")
    try:
        product = json.loads(product_file.original.decode("utf-8-sig"))
    except Exception as exc:
        raise SandToolError("product.json 无法解析，拒绝提交补丁") from exc
    if not isinstance(product, dict):
        raise SandToolError("product.json 顶层必须是对象")
    checksums = product.get("checksums")
    if not isinstance(checksums, dict):
        return

    out_root = (layout.app_root / "out").resolve()
    changed = False
    for key in list(checksums.keys()):
        if not isinstance(key, str):
            continue
        parts = [part for part in re.split(r"[\\/]", key) if part]
        target = out_root.joinpath(*parts).resolve()
        if not _is_within(target, out_root):
            raise SandToolError(f"product.json checksum 路径逃逸：{key}")
        planned = plan.get(target)
        if planned is not None:
            data = planned.next_bytes
        elif target.is_file():
            data = target.read_bytes()
        else:
            continue
        digest = _product_checksum(data)
        if checksums.get(key) != digest:
            checksums[key] = digest
            changed = True

    if not changed:
        return
    text = json.dumps(product, ensure_ascii=False, indent="\t")
    next_bytes = text.encode("utf-8")
    if has_bom:
        next_bytes = b"\xef\xbb\xbf" + next_bytes
    plan[layout.product_json] = PlannedFile(
        original=product_file.original,
        next_bytes=next_bytes,
        mode=product_file.mode,
    )


def _planned_extension_names(
    layout: CursorLayout,
    plan: Mapping[Path, PlannedFile],
) -> Set[str]:
    names: Set[str] = set()
    for file_path in plan:
        extension_name = _target_extension_name(layout, file_path)
        if extension_name:
            names.add(extension_name)
    return names


def _verify_extension_hashes(
    layout: CursorLayout,
    extension_names: Iterable[str],
) -> None:
    names = set(extension_names)
    if layout.ext_host_path is None or not names:
        return
    ext_content = _decode_js(layout.ext_host_path.read_bytes(), layout.ext_host_path)
    for rel, extension_name in TARGET_SPECS:
        if not extension_name or extension_name not in names:
            continue
        main_path = layout.app_root.joinpath(*rel.split("/"))
        if not main_path.is_file():
            continue
        extension_id = "anysphere." + extension_name
        if f'"{extension_id}"' not in ext_content:
            continue
        pattern = re.compile(
            rf'\"{re.escape(extension_id)}\"\s*:\s*\{{[\s\S]{{0,2400}}?'
            rf'\"main\.js\"\s*:\s*\"([0-9a-f]{{64}})\"'
        )
        match = pattern.search(ext_content)
        if not match:
            raise SandToolError(f"无法验证 {extension_id} 的内嵌哈希")
        expected = hashlib.sha256(main_path.read_bytes()).hexdigest()
        if match.group(1) != expected:
            raise SandToolError(f"{extension_id} 的内嵌哈希校验失败")


def _verify_product_checksums(layout: CursorLayout) -> int:
    product = json.loads(layout.product_json.read_bytes().decode("utf-8-sig"))
    checksums = product.get("checksums") if isinstance(product, dict) else None
    if not isinstance(checksums, dict):
        return 0
    out_root = (layout.app_root / "out").resolve()
    checked = 0
    for key, written in checksums.items():
        if not isinstance(key, str):
            continue
        parts = [part for part in re.split(r"[\\/]", key) if part]
        target = out_root.joinpath(*parts).resolve()
        if not _is_within(target, out_root) or not target.is_file():
            continue
        checked += 1
        if written != _product_checksum(target.read_bytes()):
            raise SandToolError(f"product.json 完整性哈希校验失败：{key}")
    return checked


def inspect_status(layout: CursorLayout) -> PatchStatus:
    client_markers = 0
    eligibility_markers = 0
    legacy_client_markers = 0
    legacy_eligibility_markers = 0
    ide_matches = 0
    external_sand_matches = 0
    external_marker_count = 0
    patched_files: List[Path] = []
    for target in layout.target_paths:
        content = _decode_js(target.read_bytes(), target)
        client_count = content.count(SAND_CLIENT_MARKER) + content.count(
            SAND_CLIENT_EXISTING_MARKER
        )
        eligibility_count = content.count(SAND_ELIGIBILITY_MARKER)
        legacy_client_count = len(
            re.findall(
                rf"([\"'])sand\1{LEGACY_CLIENT_MARKER_PATTERN}",
                content,
            )
        )
        legacy_eligibility_count = content.count(
            "return!1;" + LEGACY_SAND_ELIGIBILITY_MARKER
        )
        external_marker_count += max(
            0,
            len(re.findall(CLIENT_MARKER_GUARD_PATTERN, content))
            - client_count
            - legacy_client_count,
        )
        external_marker_count += max(
            0,
            len(re.findall(ELIGIBILITY_MARKER_GUARD_PATTERN, content))
            - eligibility_count
            - legacy_eligibility_count,
        )
        if (
            client_count
            + eligibility_count
            + legacy_client_count
            + legacy_eligibility_count
        ):
            patched_files.append(target)
        client_markers += client_count
        eligibility_markers += eligibility_count
        legacy_client_markers += legacy_client_count
        legacy_eligibility_markers += legacy_eligibility_count
        for _key, rule in CLIENT_RULES:
            for match in rule.finditer(content):
                if match.group(3) == "sand":
                    external_sand_matches += 1
                else:
                    ide_matches += 1
    return PatchStatus(
        client_markers=client_markers,
        eligibility_markers=eligibility_markers,
        ide_matches=ide_matches,
        external_sand_matches=external_sand_matches,
        external_marker_count=external_marker_count,
        legacy_client_markers=legacy_client_markers,
        legacy_eligibility_markers=legacy_eligibility_markers,
        patched_files=tuple(patched_files),
    )


def _create_backup(
    layout: CursorLayout,
    plan: Mapping[Path, PlannedFile],
    operation: str,
) -> Tuple[Path, Dict[str, object]]:
    app_hash = hashlib.sha256(str(layout.app_root).encode("utf-8")).hexdigest()[:16]
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S.%fZ")
    backup_dir = _config_dir() / "backups" / app_hash / f"{stamp}-{operation}"
    files_dir = backup_dir / "files"
    entries: List[Dict[str, object]] = []
    for path, planned in plan.items():
        try:
            relative = path.resolve().relative_to(layout.app_root.resolve())
        except ValueError as exc:
            raise SandToolError(f"计划文件逃逸出 Cursor app：{path}") from exc
        backup_file = files_dir / relative
        _atomic_write(backup_file, planned.original, planned.mode)
        entries.append(
            {
                "path": relative.as_posix(),
                "originalSha256": _sha256(planned.original),
                "nextSha256": _sha256(planned.next_bytes),
                "mode": planned.mode,
            }
        )
    manifest: Dict[str, object] = {
        "version": 1,
        "toolVersion": TOOL_VERSION,
        "operation": operation,
        "status": "prepared",
        "appRoot": str(layout.app_root),
        "cursorVersion": layout.version,
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "files": entries,
    }
    _write_json_atomic(backup_dir / "manifest.json", manifest)
    return backup_dir, manifest


def _update_backup_manifest(
    backup_dir: Path,
    manifest: Dict[str, object],
    status_value: str,
    error: Optional[str] = None,
) -> None:
    manifest["status"] = status_value
    manifest["finishedAt"] = datetime.now(timezone.utc).isoformat()
    if error:
        manifest["error"] = error[:1000]
    _write_json_atomic(backup_dir / "manifest.json", manifest)


def _commit_plan(
    layout: CursorLayout,
    plan: Mapping[Path, PlannedFile],
    operation: str,
    validator,
) -> Tuple[Tuple[Path, ...], Path]:
    if not plan:
        raise SandToolError("内部错误：提交计划为空")
    for path, planned in plan.items():
        if _sha256(path.read_bytes()) != _sha256(planned.original):
            raise SandToolError(f"文件在计划生成后发生变化，已停止操作：{path}")
    backup_dir, manifest = _create_backup(layout, plan, operation)
    attempted: List[Path] = []
    written: List[Path] = []
    try:
        for path, planned in plan.items():
            if _sha256(path.read_bytes()) != _sha256(planned.original):
                raise SandToolError(f"文件在写入前发生变化，已停止操作：{path}")
            attempted.append(path)
            _atomic_write(path, planned.next_bytes, planned.mode)
            written.append(path)
        validator()
        for path, planned in plan.items():
            if _sha256(path.read_bytes()) != _sha256(planned.next_bytes):
                raise SandToolError(f"写入后哈希校验失败：{path}")
        _update_backup_manifest(backup_dir, manifest, "committed")
        return tuple(written), backup_dir
    except (Exception, KeyboardInterrupt) as exc:
        rollback_errors: List[str] = []
        for path in reversed(attempted):
            planned = plan[path]
            try:
                current_hash = _sha256(path.read_bytes())
                original_hash = _sha256(planned.original)
                next_hash = _sha256(planned.next_bytes)
                if current_hash == original_hash:
                    continue
                if current_hash != next_hash:
                    rollback_errors.append(f"{path}: 文件已被外部修改，未覆盖")
                    continue
                _atomic_write(path, planned.original, planned.mode)
            except Exception as rollback_exc:
                rollback_errors.append(f"{path}: {rollback_exc}")
        message = str(exc)
        if rollback_errors:
            message += "; rollback errors: " + " | ".join(rollback_errors)
        try:
            _update_backup_manifest(backup_dir, manifest, "rolled_back", message)
        except Exception:
            pass
        if rollback_errors:
            raise SandToolError(
                "补丁失败且有文件未能自动回滚，请保留备份目录："
                f"{backup_dir}\n{message}"
            ) from exc
        raise


def _windows_close_cursor(layout: CursorLayout) -> int:
    powershell = _powershell_executable()
    if not powershell:
        raise SandToolError("未找到 PowerShell，无法安全关闭 Cursor")
    script = r"""
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
$target = [System.IO.Path]::GetFullPath($env:SAND_CURSOR_EXE)
function Get-SandCursorTargets {
  @(Get-CimInstance Win32_Process -Filter "Name='Cursor.exe'" -ErrorAction Stop | Where-Object {
    $_.ExecutablePath -and [string]::Equals(
      [System.IO.Path]::GetFullPath($_.ExecutablePath),
      $target,
      [System.StringComparison]::OrdinalIgnoreCase
    )
  })
}
$before = @(Get-SandCursorTargets)
foreach ($item in $before) {
  try {
    $process = Get-Process -Id $item.ProcessId -ErrorAction Stop
    if ($process.MainWindowHandle -ne 0) { [void]$process.CloseMainWindow() }
  } catch {}
}
$deadline = [DateTime]::UtcNow.AddSeconds(12)
while ([DateTime]::UtcNow -lt $deadline -and @(Get-SandCursorTargets).Count -gt 0) {
  Start-Sleep -Milliseconds 250
}
$remaining = @(Get-SandCursorTargets)
foreach ($item in $remaining) {
  try { Stop-Process -Id $item.ProcessId -Force -ErrorAction Stop } catch {}
}
Start-Sleep -Milliseconds 500
if (@(Get-SandCursorTargets).Count -gt 0) { exit 3 }
Write-Output ("CLOSED=" + $before.Count)
""".strip()
    env = dict(os.environ)
    env["SAND_CURSOR_EXE"] = str(layout.executable)
    try:
        result = subprocess.run(
            [powershell, "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            env=env,
            timeout=25,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise SandToolError("无法安全关闭所选 Cursor 进程，请手动退出后重试") from exc
    if result.returncode != 0:
        raise SandToolError(
            "无法安全关闭所选 Cursor 进程，请手动退出后重试"
        )
    match = re.search(r"CLOSED=(\d+)", result.stdout)
    return int(match.group(1)) if match else 0


def _mac_bundle_pids(layout: CursorLayout) -> List[int]:
    bundle = _find_app_bundle(layout.app_root)
    if bundle is None:
        return []
    contents = (bundle.resolve() / "Contents").resolve()
    pids: List[int] = []
    for pid, executable in _mac_process_paths(strict=True):
        if pid != os.getpid() and _is_within(executable, contents):
            pids.append(pid)
    return pids


def _wait_for_mac_exit(layout: CursorLayout, timeout_seconds: float) -> bool:
    deadline = time.monotonic() + timeout_seconds
    while time.monotonic() < deadline:
        if not _mac_bundle_pids(layout):
            return True
        time.sleep(0.25)
    return not _mac_bundle_pids(layout)


def _mac_close_cursor(layout: CursorLayout) -> int:
    before = _mac_bundle_pids(layout)
    if not before:
        return 0
    selected_bundle = _find_app_bundle(layout.app_root)
    running_bundles: Dict[str, Path] = {}
    for _pid, executable in _mac_process_paths(strict=True):
        bundle = _bundle_for_executable(executable)
        if bundle is not None:
            running_bundles.setdefault(_path_key(bundle), bundle)
    if selected_bundle is not None and len(running_bundles) == 1:
        osascript = shutil.which("osascript") or "/usr/bin/osascript"
        try:
            subprocess.run(
                [
                    osascript,
                    "-e",
                    'tell application id "com.todesktop.230313mzl4w4u92" to quit',
                ],
                capture_output=True,
                timeout=10,
                check=False,
            )
        except (OSError, subprocess.TimeoutExpired):
            pass
        if _wait_for_mac_exit(layout, 12):
            return len(before)

    for pid in _mac_bundle_pids(layout):
        try:
            os.kill(pid, signal.SIGTERM)
        except (ProcessLookupError, PermissionError):
            pass
    if _wait_for_mac_exit(layout, 3):
        return len(before)

    for pid in _mac_bundle_pids(layout):
        try:
            os.kill(pid, signal.SIGKILL)
        except (ProcessLookupError, PermissionError):
            pass
    if not _wait_for_mac_exit(layout, 2):
        raise SandToolError("无法安全关闭所选 Cursor 进程，请手动退出后重试")
    return len(before)


def close_cursor(layout: CursorLayout) -> int:
    if sys.platform == "win32":
        return _windows_close_cursor(layout)
    if sys.platform == "darwin":
        return _mac_close_cursor(layout)
    raise SandToolError("当前仅支持 Windows 和 macOS")


def start_cursor(layout: CursorLayout) -> bool:
    try:
        if sys.platform == "win32":
            startupinfo = subprocess.STARTUPINFO()
            startupinfo.dwFlags |= subprocess.STARTF_USESHOWWINDOW
            subprocess.Popen(
                [str(layout.executable)],
                cwd=str(layout.install_root),
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                startupinfo=startupinfo,
                creationflags=0x00000008 | 0x00000200,
            )
            return True
        if sys.platform == "darwin":
            bundle = _find_app_bundle(layout.app_root)
            if bundle is None:
                return False
            subprocess.run(
                [shutil.which("open") or "/usr/bin/open", "-a", str(bundle)],
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=20,
                check=False,
            )
            return True
    except (OSError, subprocess.TimeoutExpired):
        return False
    return False


def _build_install_plan(
    layout: CursorLayout,
) -> Tuple[Dict[Path, PlannedFile], PatchStats]:
    plan: Dict[Path, PlannedFile] = {}
    total = PatchStats()
    for target in layout.target_paths:
        original = _read_planned_file(target)
        content = _decode_js(original.original, target)
        next_content, stats = apply_patch_to_content(content)
        if next_content != content:
            plan[target] = PlannedFile(
                original=original.original,
                next_bytes=next_content.encode("utf-8"),
                mode=original.mode,
            )
        total.is_glass += stats.is_glass
        total.object_header += stats.object_header
        total.set_header += stats.set_header
        total.eligibility += stats.eligibility
        total.adopted_sand += stats.adopted_sand
        total.migrated_client += stats.migrated_client
        total.migrated_eligibility += stats.migrated_eligibility
    if plan:
        _update_extension_hashes(layout, plan)
        _sync_product_checksums(layout, plan)
    return plan, total


def _build_uninstall_plan(
    layout: CursorLayout,
) -> Tuple[Dict[Path, PlannedFile], RemoveStats]:
    plan: Dict[Path, PlannedFile] = {}
    total = RemoveStats()
    for target in layout.target_paths:
        original = _read_planned_file(target)
        content = _decode_js(original.original, target)
        next_content, stats = remove_patch_from_content(content)
        if next_content != content:
            plan[target] = PlannedFile(
                original=original.original,
                next_bytes=next_content.encode("utf-8"),
                mode=original.mode,
            )
        total.client_type += stats.client_type
        total.eligibility += stats.eligibility
    if plan:
        _update_extension_hashes(layout, plan)
        _sync_product_checksums(layout, plan)
    return plan, total


def install(layout: CursorLayout) -> int:
    before = inspect_status(layout)
    if before.external_marker_count:
        raise SandToolError(
            "检测到其他 Sand 模式标记，本脚本不会接管或覆盖它；"
            "请先用原安装方式卸载"
        )
    plan, _stats = _build_install_plan(layout)
    if not plan:
        if before.installed:
            start_cursor(layout)
            return 0
        raise SandToolError("当前 Cursor 版本未匹配到 Sand 客户端模式规则")

    close_cursor(layout)
    changed_extensions = _planned_extension_names(layout, plan)

    def validate() -> None:
        status = inspect_status(layout)
        if (
            not status.installed
            or status.ide_matches != 0
            or status.external_marker_count != 0
            or status.legacy_client_markers != 0
            or status.legacy_eligibility_markers != 0
        ):
            raise SandToolError(
                "安装后状态校验失败："
                f"markers={status.client_markers + status.eligibility_markers}, "
                f"remainingIde={status.ide_matches}, "
                "remainingLegacy="
                f"{status.legacy_client_markers + status.legacy_eligibility_markers}"
            )
        _verify_extension_hashes(layout, changed_extensions)
        _verify_product_checksums(layout)

    _commit_plan(layout, plan, "install", validate)
    close_cursor(layout)
    start_cursor(layout)
    return 0


def uninstall(layout: CursorLayout) -> int:
    before = inspect_status(layout)
    if before.external_marker_count:
        raise SandToolError(
            "检测到无法识别的 Sand 模式标记，拒绝修改；"
            "请先用原安装方式卸载"
        )
    plan, _stats = _build_uninstall_plan(layout)
    if not plan:
        start_cursor(layout)
        return 0

    close_cursor(layout)
    changed_extensions = _planned_extension_names(layout, plan)

    def validate() -> None:
        status = inspect_status(layout)
        if status.installed or status.external_marker_count:
            raise SandToolError(
                "卸载后仍有 Sand marker："
                f"{status.client_markers + status.eligibility_markers}，"
                f"external={status.external_marker_count}"
            )
        _verify_extension_hashes(layout, changed_extensions)
        _verify_product_checksums(layout)

    _commit_plan(layout, plan, "uninstall", validate)
    close_cursor(layout)
    start_cursor(layout)
    return 0


def _permission_hint() -> str:
    script = Path(__file__).resolve()
    if sys.platform == "win32":
        return "请右键以管理员身份打开 PowerShell/终端后重新运行命令。"
    return f'请使用管理员权限重试：sudo python3 "{script}" <命令>'


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Cursor Sand 客户端模式安装/卸载工具（Windows / macOS）",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "示例：\n"
            "  python \"Sand客户端模式安装工具.py\" install\n"
            "  python \"Sand客户端模式安装工具.py\" uninstall\n"
            "  python \"Sand客户端模式安装工具.py\" set-path \"E:\\Development\\IDE\\cursor\"\n"
            "  python3 \"Sand客户端模式安装工具.py\" set-path /Applications/Cursor.app\n"
            "  python \"Sand客户端模式安装工具.py\" set-path auto"
        ),
    )
    parser.add_argument("--version", action="version", version=f"%(prog)s {TOOL_VERSION}")
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("install", help="安装/注入 Sand 客户端模式")
    commands.add_parser("uninstall", help="卸载 Sand 客户端模式")
    set_path = commands.add_parser("set-path", help="设置 Cursor 路径；auto 恢复自动检测")
    set_path.add_argument(
        "path",
        help="Cursor.exe、Cursor.app、resources/app、安装根目录，或 auto",
    )
    return parser


def collect_status_lines() -> List[Tuple[str, str]]:
    try:
        layout = resolve_cursor_layout()
        status = inspect_status(layout)
    except SandToolError as exc:
        return [(str(exc), ANSI_YELLOW)]

    lines: List[Tuple[str, str]] = [
        (f"Cursor {layout.version}：{layout.install_root}", ANSI_BLUE)
    ]
    if status.installed:
        lines.append(("已安装 Sand 客户端模式", ANSI_GREEN))
    else:
        lines.append(("尚未安装 Sand 客户端模式", ANSI_YELLOW))
    if status.external_marker_count:
        lines.append(
            (f"检测到其他工具留下的标记：{status.external_marker_count} 处", ANSI_YELLOW)
        )
    return lines


def print_banner() -> None:
    print(colorize("使用前请确保当前 Cursor 账号已经获得 Sand 资格", ANSI_YELLOW))
    print(colorize(f"官方领取页面：{SAND_ONBOARDING_URL}", ANSI_BLUE))
    for text, code in collect_status_lines():
        print(colorize(text, code))
    print()


def apply_set_path(value: str) -> int:
    save_cursor_path(value)
    return 0


def print_menu() -> None:
    print(colorize("请选择操作：", ANSI_BOLD))
    print(colorize("  1", ANSI_BOLD, ANSI_GREEN) + ") 安装")
    print(colorize("  2", ANSI_BOLD, ANSI_GREEN) + ") 卸载")
    print(colorize("  3", ANSI_BOLD, ANSI_GREEN) + ") 设置 Cursor 路径")


def prompt_set_path() -> int:
    value = input(colorize("路径> ", ANSI_BLUE)).strip()
    if not value:
        return 0
    with LoadingSpinner("正在设置路径"):
        return apply_set_path(value)


def run_choice(choice: str) -> Optional[int]:
    if choice == "1":
        with LoadingSpinner("正在安装"):
            return install(resolve_cursor_layout())
    if choice == "2":
        with LoadingSpinner("正在卸载"):
            return uninstall(resolve_cursor_layout())
    if choice == "3":
        return prompt_set_path()
    print_warn("无效选项，请输入 1-3。")
    return 0


def interactive_loop() -> int:
    while True:
        print_banner()
        print_menu()
        try:
            choice = input(colorize("请输入编号> ", ANSI_BLUE)).strip()
        except EOFError:
            print()
            return 0
        try:
            run_choice(choice)
        except PermissionError as exc:
            print_error(f"错误：没有写入权限：{exc}")
            print_error(_permission_hint())
        except SandToolError as exc:
            print_error(f"错误：{exc}")
        except KeyboardInterrupt:
            print()
            return 0
        except Exception as exc:
            print_error(f"未预期错误：{exc}")
        print()


def main(argv: Optional[Sequence[str]] = None) -> int:
    _configure_console()
    args_list = list(sys.argv[1:] if argv is None else argv)
    try:
        _platform_name()
        if not args_list:
            return interactive_loop()

        print_banner()
        args = build_parser().parse_args(args_list)
        if args.command == "set-path":
            return apply_set_path(args.path)

        layout = resolve_cursor_layout()
        if args.command == "install":
            return install(layout)
        if args.command == "uninstall":
            return uninstall(layout)
        raise SandToolError(f"未知命令：{args.command}")
    except PermissionError as exc:
        print_error(f"错误：没有写入权限：{exc}")
        print_error(_permission_hint())
        return 3
    except SandToolError as exc:
        print_error(f"错误：{exc}")
        return 2
    except KeyboardInterrupt:
        print_error("操作已取消。")
        return 130
    except Exception as exc:
        print_error(f"未预期错误：{exc}")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
