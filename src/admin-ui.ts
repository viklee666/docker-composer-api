/**
 * /admin 单页管理后台。
 * 纯内联 HTML/CSS/JS，无外部资源依赖（容器离线也可用）。
 * 注意：本文件用普通模板字符串承载 HTML，内部 JS 一律使用单引号与字符串拼接，
 * 避免出现反引号与 ${} 与 TS 模板语法冲突。
 */
export const ADMIN_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>Composer API 管理后台</title>
<style>
:root{
  --bg:#0b0f17;--panel:#111726;--panel-2:#161e30;--border:#232d45;
  --text:#e6ebf5;--muted:#8b96ad;--accent:#5b8cff;--accent-2:#36c6b0;
  --green:#2ecc8f;--red:#ff6b6b;--yellow:#f5b84d;
  --radius:14px;--mono:ui-monospace,SFMono-Regular,Consolas,Menlo,monospace;
}
*{box-sizing:border-box;margin:0;padding:0}
body{
  background:radial-gradient(1200px 600px at 80% -10%,#16203a 0%,var(--bg) 55%);
  color:var(--text);min-height:100vh;
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;
}
a{color:var(--accent)}
.hidden{display:none!important}
.wrap{max-width:1180px;margin:0 auto;padding:24px 20px 60px}
header.app{display:flex;align-items:center;gap:14px;padding:6px 2px 22px;flex-wrap:wrap}
.logo{width:38px;height:38px;border-radius:11px;background:linear-gradient(135deg,var(--accent),var(--accent-2));
  display:flex;align-items:center;justify-content:center;font-weight:800;font-size:17px;color:#06101f}
h1{font-size:19px;font-weight:700;letter-spacing:.3px}
.sub{color:var(--muted);font-size:12.5px;margin-top:2px;display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.chip{border:1px solid var(--border);background:var(--panel);border-radius:999px;padding:2px 10px;font-size:11.5px;color:var(--muted)}
.chip.ok{color:var(--green);border-color:rgba(46,204,143,.35)}
.spacer{flex:1}
button{
  font:inherit;color:var(--text);background:var(--panel-2);border:1px solid var(--border);
  border-radius:9px;padding:7px 14px;cursor:pointer;transition:.15s;font-size:13px;
}
button:hover{border-color:var(--accent);color:#fff}
button.primary{background:linear-gradient(135deg,var(--accent),#3f6fe0);border-color:transparent;font-weight:600}
button.primary:hover{filter:brightness(1.1)}
button.danger:hover{border-color:var(--red);color:var(--red)}
button:disabled{opacity:.5;cursor:not-allowed}
input,select,textarea{
  font:inherit;color:var(--text);background:#0d1322;border:1px solid var(--border);
  border-radius:9px;padding:8px 11px;font-size:13px;outline:none;transition:.15s;
}
input:focus,select:focus,textarea:focus{border-color:var(--accent)}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:14px;margin-bottom:18px}
.card{background:var(--panel);border:1px solid var(--border);border-radius:var(--radius);padding:16px 18px}
.card .k{color:var(--muted);font-size:12px;margin-bottom:8px;display:flex;align-items:center;gap:6px}
.card .v{font-size:25px;font-weight:700;font-variant-numeric:tabular-nums}
.card .d{color:var(--muted);font-size:12px;margin-top:6px}
.panel{background:var(--panel);border:1px solid var(--border);border-radius:var(--radius);margin-bottom:18px;overflow:hidden}
.panel>.head{display:flex;align-items:center;gap:10px;padding:14px 18px;border-bottom:1px solid var(--border)}
.panel>.head h2{font-size:14.5px;font-weight:650}
.panel>.head .hint{color:var(--muted);font-size:12px}
.panel>.body{padding:16px 18px}
table{width:100%;border-collapse:collapse;font-size:12.8px}
th{color:var(--muted);text-align:left;font-weight:500;padding:8px 10px;border-bottom:1px solid var(--border);white-space:nowrap}
td{padding:9px 10px;border-bottom:1px solid #1a2235;vertical-align:top}
tr:last-child td{border-bottom:none}
td.mono,.mono{font-family:var(--mono);font-size:12px}
.badge{display:inline-block;border-radius:999px;padding:2px 9px;font-size:11px;font-weight:600}
.badge.active{background:rgba(46,204,143,.12);color:var(--green)}
.badge.disabled{background:rgba(255,107,107,.12);color:var(--red)}
.badge.gateway{background:rgba(91,140,255,.12);color:var(--accent)}
.badge.direct{background:rgba(245,184,77,.14);color:var(--yellow)}
.badge.admin{background:rgba(54,198,176,.13);color:var(--accent-2)}
.badge.sand{background:rgba(168,130,255,.14);color:#c4a6ff}
.badge.sdk{background:rgba(91,140,255,.12);color:var(--accent)}
.badge.inherit{background:rgba(139,150,173,.12);color:var(--muted)}
.badge.s2xx{background:rgba(46,204,143,.12);color:var(--green)}
.badge.s4xx{background:rgba(245,184,77,.14);color:var(--yellow)}
.badge.s5xx{background:rgba(255,107,107,.12);color:var(--red)}
.row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.muted{color:var(--muted)}
.small{font-size:12px}
.err-text{color:var(--red);font-size:11.5px;word-break:break-all}
.empty{color:var(--muted);text-align:center;padding:26px 0;font-size:13px}
.actions{display:flex;gap:6px;flex-wrap:wrap}
.actions button{padding:4px 10px;font-size:12px;border-radius:7px}
#test-result{margin-top:12px;background:#0d1322;border:1px solid var(--border);border-radius:9px;
  padding:12px;font-family:var(--mono);font-size:12.5px;white-space:pre-wrap;word-break:break-all}
.table-scroll{overflow-x:auto}
/* login */
#login{position:fixed;inset:0;background:var(--bg);display:flex;align-items:center;justify-content:center;z-index:50}
.login-card{width:min(380px,92vw);background:var(--panel);border:1px solid var(--border);border-radius:18px;padding:34px 30px}
.login-card .logo{width:46px;height:46px;font-size:20px;margin-bottom:16px}
.login-card h1{font-size:20px;margin-bottom:6px}
.login-card p{color:var(--muted);font-size:13px;margin-bottom:20px}
.login-card input{width:100%;margin-bottom:12px;padding:11px 13px}
.login-card button{width:100%;padding:11px}
.login-err{color:var(--red);font-size:12.5px;min-height:18px;margin-bottom:8px}
/* toast */
#toast{position:fixed;right:18px;bottom:18px;display:flex;flex-direction:column;gap:8px;z-index:99}
.toast{background:var(--panel-2);border:1px solid var(--border);border-left:3px solid var(--accent);
  border-radius:10px;padding:10px 16px;font-size:13px;box-shadow:0 8px 30px rgba(0,0,0,.45);animation:in .2s ease}
.toast.bad{border-left-color:var(--red)}
@keyframes in{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
label.toggle{display:flex;align-items:center;gap:6px;color:var(--muted);font-size:12.5px;cursor:pointer;user-select:none}
</style>
</head>
<body>

<div id="login">
  <div class="login-card">
    <div class="logo">C</div>
    <h1>Composer API 管理后台</h1>
    <p>请输入管理密码（ADMIN_PASSWORD，未设置时为 GATEWAY_API_KEY）</p>
    <div class="login-err" id="login-err"></div>
    <input id="login-pass" type="password" placeholder="管理密码" autocomplete="current-password">
    <button class="primary" id="login-btn">登 录</button>
  </div>
</div>

<div class="wrap hidden" id="app">
  <header class="app">
    <div class="logo">C</div>
    <div>
      <h1>Composer API 管理后台</h1>
      <div class="sub">
        <span class="chip ok" id="chip-status">● 运行中</span>
        <span class="chip" id="chip-version">v-</span>
        <span class="chip" id="chip-uptime">运行 -</span>
        <span class="chip" id="chip-direct">直传 key：-</span>
        <span class="chip" id="chip-http1">HTTP：-</span>
        <span class="chip" id="chip-autodisable">自动禁用：-</span>
        <span class="chip" id="chip-sand">通道：-</span>
      </div>
    </div>
    <div class="spacer"></div>
    <label class="toggle"><input type="checkbox" id="auto-refresh" checked> 10s 自动刷新</label>
    <button id="btn-refresh">刷新</button>
    <button id="btn-logout" class="danger">退出</button>
  </header>

  <div class="grid">
    <div class="card"><div class="k">Cursor Key（可用 / 总数）</div><div class="v" id="st-keys">-</div><div class="d" id="st-keys-d">-</div></div>
    <div class="card"><div class="k">总请求数</div><div class="v" id="st-total">-</div><div class="d" id="st-total-d">-</div></div>
    <div class="card"><div class="k">近 24 小时</div><div class="v" id="st-24h">-</div><div class="d" id="st-24h-d">-</div></div>
    <div class="card"><div class="k">平均耗时</div><div class="v" id="st-avg">-</div><div class="d">仅统计已完成请求</div></div>
  </div>

  <div class="panel">
    <div class="head"><h2>运行设置</h2><span class="hint">设置会保存到数据库并立即影响后续新建的 Cursor local agent</span></div>
    <div class="body">
      <div class="row" style="margin-bottom:10px">
        <label class="toggle" style="font-size:13px;color:var(--text)">
          <input type="checkbox" id="max-mode-toggle">
          支持的模型默认开启 Max Mode（大上下文 / 1M）
        </label>
        <label class="toggle" style="font-size:13px;color:var(--text)">
          <input type="checkbox" id="fast-toggle">
          支持的模型默认开启 Fast
        </label>
      </div>
      <div class="row" style="margin-bottom:10px">
        <label class="toggle" style="font-size:13px;color:var(--text)">
          <input type="checkbox" id="sdk-http1-toggle">
          强制 Cursor local agent 使用 HTTP/1.1 + SSE
        </label>
      </div>
      <div class="row" style="margin-bottom:10px">
        <label class="toggle" style="font-size:13px;color:var(--text)">
          <input type="checkbox" id="sand-mode-toggle">
          全局默认走 Sand 通道（x-cursor-client-type: sand）
        </label>
        <span class="muted small" id="sand-hook-hint"></span>
      </div>
      <div class="row" style="margin-bottom:10px">
        <label class="toggle" style="font-size:13px;color:var(--text)">
          <input type="checkbox" id="auto-disable-toggle">
          额度不足 / key 失效时自动禁用 key
        </label>
        <label class="toggle" style="font-size:13px;color:var(--text)">
          连续失败
          <input type="number" id="auto-disable-threshold" min="1" max="50" step="1" style="width:66px;padding:6px 8px">
          次后才禁用
        </label>
      </div>
      <div class="row">
        <button id="btn-save-settings">保存设置</button>
        <span class="muted small">Max Mode / Fast 仅对支持对应参数的模型生效（如 gpt-5.x / claude 系；composer 无 context 档位）。部分模型（如 GPT-5.x）1M 与 fast 不能共存，此时按模型的合法组合自动取舍，Max Mode 优先。客户端在请求里显式指定时以客户端为准。HTTP/1.1 用于代理不兼容 HTTP/2 的排查。关闭自动禁用后，出错的 key 只会本次跳过、永远不会被自动停用（需自己盯着额度）；计数按连续失败算，成功一次即清零。Sand 通道只改 client-type 头，走 Grok Bot 额度，不解除账号级限制（发票 / hard limit / Grok 额度）。总开关作用于所有「跟随全局」的 key；单个 key 可强制 SDK 或 Sand。</span>
      </div>
    </div>
  </div>

  <div class="panel">
    <div class="head">
      <h2>Cursor Key 池</h2>
      <span class="hint">按下表顺序取第一个可用 key（↑↓ 可调整）；额度不足/失效连续达到上方阈值才自动禁用并切换下一个，上游临时报错只换下一个不禁用；被禁用的 key 需手动启用，全部禁用时 API 统一返回无有效 key</span>
    </div>
    <div class="body">
      <div class="row" style="margin-bottom:14px">
        <input id="new-key" placeholder="粘贴 Cursor API Key（key_...）" style="flex:2;min-width:260px" autocomplete="off">
        <input id="new-label" placeholder="备注（可选）" style="flex:1;min-width:140px" autocomplete="off">
        <select id="new-channel" style="min-width:120px" title="该 key 的 Cursor 通道">
          <option value="inherit">跟随全局</option>
          <option value="sdk">强制 SDK</option>
          <option value="sand">强制 Sand</option>
        </select>
        <button class="primary" id="btn-add-key">添加 Key</button>
      </div>
      <div class="table-scroll">
        <table>
          <thead><tr>
            <th>顺序</th><th>备注</th><th>Key</th><th>状态</th><th>通道</th><th>来源</th><th>请求数</th><th>最近使用</th><th>禁用原因 / 最近错误</th><th>操作</th>
          </tr></thead>
          <tbody id="keys-body"></tbody>
        </table>
      </div>
      <div class="empty hidden" id="keys-empty">暂无 key，请添加或在 .env 配置 CURSOR_API_KEYS</div>
    </div>
  </div>

  <div class="panel">
    <div class="head"><h2>联通性测试</h2><span class="hint">下方按钮走密钥池（测当前队首可用 key）；逐个验证某个 key 请用上方 Key 池表格每行的「测试」按钮。均会真实消耗额度</span></div>
    <div class="body">
      <div class="row">
        <select id="test-model" style="min-width:180px"></select>
        <input id="test-prompt" value="Reply with exactly: pong" style="flex:1;min-width:220px">
        <button class="primary" id="btn-test">发送测试</button>
      </div>
      <div id="test-result" class="hidden"></div>
    </div>
  </div>

  <div class="panel">
    <div class="head">
      <h2>请求日志</h2>
      <span class="hint">最近 50 条</span>
      <div class="spacer"></div>
    </div>
    <div class="body">
      <div class="table-scroll">
        <table>
          <thead><tr>
            <th>时间</th><th>端点</th><th>模型</th><th>模式</th><th>Key</th><th>状态</th><th>耗时</th><th>错误</th>
          </tr></thead>
          <tbody id="logs-body"></tbody>
        </table>
      </div>
      <div class="empty hidden" id="logs-empty">暂无请求记录</div>
    </div>
  </div>
</div>

<div id="toast"></div>

<script>
(function(){
  'use strict';
  var TOKEN_KEY = 'composer_admin_token';
  var token = localStorage.getItem(TOKEN_KEY) || '';
  var timer = null;
  var loading = false;

  function $(id){ return document.getElementById(id); }
  function esc(value){
    return String(value == null ? '' : value)
      .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
      .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  }
  function toast(message, bad){
    var box = document.createElement('div');
    box.className = 'toast' + (bad ? ' bad' : '');
    box.textContent = message;
    $('toast').appendChild(box);
    setTimeout(function(){ box.remove(); }, 3600);
  }
  function api(method, path, body){
    var options = { method: method, headers: { 'authorization': 'Bearer ' + token } };
    if (method === 'POST' || body !== undefined) {
      options.headers['content-type'] = 'application/json';
      options.body = JSON.stringify(body === undefined ? {} : body);
    }
    return fetch(path, options).then(function(res){
      return res.json().catch(function(){ return {}; }).then(function(data){
        if (res.status === 401) { showLogin('密码错误或已失效，请重新登录'); throw new Error('unauthorized'); }
        if (!res.ok) {
          var message = data && data.error && data.error.message ? data.error.message : ('HTTP ' + res.status);
          throw new Error(message);
        }
        return data;
      });
    });
  }

  function showLogin(message){
    stopTimer();
    $('app').classList.add('hidden');
    $('login').classList.remove('hidden');
    $('login-err').textContent = message || '';
    $('login-pass').focus();
  }
  function showApp(){
    $('login').classList.add('hidden');
    $('app').classList.remove('hidden');
  }
  function login(){
    var pass = $('login-pass').value.trim();
    if (!pass) { $('login-err').textContent = '请输入密码'; return; }
    token = pass;
    api('POST', '/admin/api/login').then(function(){
      localStorage.setItem(TOKEN_KEY, token);
      showApp();
      loadAll();
      startTimer();
    }).catch(function(err){
      if (err.message !== 'unauthorized') $('login-err').textContent = err.message;
    });
  }

  function fmtUptime(seconds){
    if (seconds == null) return '-';
    var d = Math.floor(seconds / 86400);
    var h = Math.floor(seconds % 86400 / 3600);
    var m = Math.floor(seconds % 3600 / 60);
    if (d > 0) return d + '天' + h + '时';
    if (h > 0) return h + '时' + m + '分';
    return m + '分' + Math.floor(seconds % 60) + '秒';
  }
  function fmtTime(iso){
    if (!iso) return '—';
    var date = new Date(iso);
    if (isNaN(date.getTime())) return '—';
    return date.toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }
  function statusClass(code){
    if (code < 400) return 's2xx';
    if (code < 500) return 's4xx';
    return 's5xx';
  }

  function renderOverview(data){
    $('chip-version').textContent = 'v' + data.version;
    $('chip-uptime').textContent = '运行 ' + fmtUptime(data.uptimeSeconds);
    $('chip-direct').textContent = '直传 key：' + (data.config.allowDirectCursorKeys ? '允许' : '禁止');
    $('chip-http1').textContent = 'HTTP：' + (data.config.cursorSdkUseHttp1ForAgent ? '1.1' : '默认');
    $('sdk-http1-toggle').checked = !!data.config.cursorSdkUseHttp1ForAgent;
    $('max-mode-toggle').checked = !!data.config.cursorMaxMode;
    $('fast-toggle').checked = !!data.config.cursorFast;
    autoDisableThreshold = data.config.autoDisableThreshold || 1;
    $('auto-disable-toggle').checked = !!data.config.autoDisableKeys;
    $('auto-disable-threshold').value = autoDisableThreshold;
    $('chip-autodisable').textContent = '自动禁用：'
      + (data.config.autoDisableKeys ? '连续失败 ' + autoDisableThreshold + ' 次' : '已关闭');
    sandClientMode = !!data.config.sandClientMode;
    $('sand-mode-toggle').checked = sandClientMode;
    $('chip-sand').textContent = '通道：' + (sandClientMode ? 'Sand' : 'SDK');
    $('sand-hook-hint').textContent = sandClientMode && data.config.sandClientHookPatched === false
      ? '（SDK 尚未加载或注入未生效，重启后看启动日志）'
      : '';
    $('st-keys').textContent = data.keys.active + ' / ' + data.keys.total;
    $('st-keys-d').textContent = '已禁用 ' + data.keys.disabled + ' 个';
    $('st-total').textContent = data.requests.total;
    var rate = data.requests.total ? Math.round(data.requests.success / data.requests.total * 100) : null;
    $('st-total-d').textContent = rate == null ? '暂无数据' : '成功率 ' + rate + '%（失败 ' + data.requests.errors + '）';
    $('st-24h').textContent = data.requests.last24h.total;
    $('st-24h-d').textContent = '其中失败 ' + data.requests.last24h.errors;
    $('st-avg').textContent = data.requests.avgDurationMs == null ? '—' : (data.requests.avgDurationMs / 1000).toFixed(1) + 's';
    var select = $('test-model');
    if (select.options.length === 0 && data.models) {
      data.models.forEach(function(id){
        var option = document.createElement('option');
        option.value = id;
        option.textContent = id;
        select.appendChild(option);
      });
    }
  }

  var lastKeys = [];
  var autoDisableThreshold = 1;
  var sandClientMode = false;

  function channelLabel(value){
    if (value === 'sand') return 'Sand';
    if (value === 'sdk') return 'SDK';
    return '跟随全局';
  }
  function resolvedChannel(key){
    if (key.clientType === 'sand' || key.clientType === 'sdk') return key.clientType;
    return sandClientMode ? 'sand' : 'sdk';
  }
  function channelSelect(key){
    var current = key.clientType === 'sand' || key.clientType === 'sdk' ? key.clientType : 'inherit';
    var html = '<select data-action="channel" data-id="' + key.id + '" title="该 key 的 Cursor 通道" style="padding:4px 8px;font-size:12px">';
    [['inherit','跟随全局'],['sdk','强制 SDK'],['sand','强制 Sand']].forEach(function(item){
      html += '<option value="' + item[0] + '"' + (current === item[0] ? ' selected' : '') + '>' + item[1] + '</option>';
    });
    html += '</select>';
    var resolved = resolvedChannel(key);
    html += ' <span class="badge ' + resolved + '">' + (resolved === 'sand' ? 'Sand' : 'SDK') + '</span>';
    return html;
  }

  function renderKeys(keys){
    lastKeys = keys;
    var body = $('keys-body');
    $('keys-empty').classList.toggle('hidden', keys.length > 0);
    var html = '';
    keys.forEach(function(key, index){
      var reason = '';
      if (key.status === 'disabled' && key.disabledReason) {
        reason = '<span class="badge disabled">' + esc(key.disabledReason) + '</span>';
        if (key.disabledAt) reason += ' <span class="muted small">' + fmtTime(key.disabledAt) + '</span>';
      }
      if (key.status === 'active' && key.failureCount > 0) {
        reason += '<span class="muted small">连续失败 ' + key.failureCount + ' / ' + autoDisableThreshold + ' 次</span>';
      }
      if (key.lastError) reason += '<div class="err-text">' + esc(key.lastError) + '</div>';
      var order = '<div class="actions" style="flex-wrap:nowrap;align-items:center">'
        + '<span class="muted mono" style="min-width:18px;text-align:right">' + (index + 1) + '</span>'
        + '<button data-action="up" data-id="' + key.id + '" title="上移（提高优先级）"' + (index === 0 ? ' disabled' : '') + '>↑</button>'
        + '<button data-action="down" data-id="' + key.id + '" title="下移（降低优先级）"' + (index === keys.length - 1 ? ' disabled' : '') + '>↓</button>'
        + '</div>';
      var actions = '<button data-action="test" data-id="' + key.id + '">测试</button>';
      if (key.status === 'active') {
        actions += '<button data-action="disable" data-id="' + key.id + '">禁用</button>';
      } else {
        actions += '<button data-action="enable" data-id="' + key.id + '">启用</button>';
      }
      actions += '<button class="danger" data-action="delete" data-id="' + key.id + '">删除</button>';
      html += '<tr>'
        + '<td>' + order + '</td>'
        + '<td>' + esc(key.label) + '</td>'
        + '<td class="mono">' + esc(key.maskedKey) + '</td>'
        + '<td><span class="badge ' + key.status + '">' + (key.status === 'active' ? '可用' : '已禁用') + '</span></td>'
        + '<td>' + channelSelect(key) + '</td>'
        + '<td class="muted">' + (key.source === 'env' ? '环境变量' : '手动添加') + '</td>'
        + '<td>' + key.requestCount + '</td>'
        + '<td class="muted small">' + fmtTime(key.lastUsedAt) + '</td>'
        + '<td>' + (reason || '<span class="muted">—</span>') + '</td>'
        + '<td><div class="actions">' + actions + '</div></td>'
        + '</tr>';
    });
    body.innerHTML = html;
  }

  function testKey(id, button){
    var original = button.textContent;
    button.disabled = true;
    button.textContent = '测试中…';
    api('POST', '/admin/api/test', { keyId: id, model: $('test-model').value, prompt: $('test-prompt').value })
      .then(function(data){
        if (data.ok) {
          toast('✔ key 可用（' + (data.durationMs / 1000).toFixed(1) + 's，' + (data.keyLabel || '-') + '）');
        } else {
          toast('✘ ' + (data.keyLabel || '-') + ' 失败：' + data.error, true);
        }
        loadAll();
      })
      .catch(function(err){ toast('测试失败：' + err.message, true); })
      .finally(function(){ button.disabled = false; button.textContent = original; });
  }

  function moveKey(id, delta){
    var ids = lastKeys.map(function(key){ return key.id; });
    var from = ids.indexOf(id);
    var to = from + delta;
    if (from < 0 || to < 0 || to >= ids.length) return;
    ids.splice(from, 1);
    ids.splice(to, 0, id);
    api('POST', '/admin/api/keys/reorder', { ids: ids }).then(function(data){
      renderKeys(data.keys);
      toast('已调整顺序');
    }).catch(function(err){ toast('调整失败：' + err.message, true); });
  }

  function renderLogs(logs){
    var body = $('logs-body');
    $('logs-empty').classList.toggle('hidden', logs.length > 0);
    var html = '';
    logs.forEach(function(log){
      html += '<tr>'
        + '<td class="muted small" style="white-space:nowrap">' + fmtTime(log.ts) + '</td>'
        + '<td class="mono">' + esc(log.endpoint) + (log.stream ? ' <span class="muted small">(stream)</span>' : '') + '</td>'
        + '<td class="mono">' + esc(log.model || '—') + '</td>'
        + '<td><span class="badge ' + esc(log.authMode) + '">' + esc(log.authMode) + '</span></td>'
        + '<td class="muted small">' + esc(log.keyLabel || '—') + '</td>'
        + '<td><span class="badge ' + statusClass(log.status) + '">' + log.status + '</span></td>'
        + '<td class="muted">' + (log.durationMs / 1000).toFixed(1) + 's</td>'
        + '<td>' + (log.error ? '<div class="err-text">' + esc(log.error) + '</div>' : '<span class="muted">—</span>') + '</td>'
        + '</tr>';
    });
    body.innerHTML = html;
  }

  var loadGen = 0;
  function loadAll(){
    var gen = ++loadGen;
    loading = true;
    Promise.all([
      api('GET', '/admin/api/overview'),
      api('GET', '/admin/api/keys'),
      api('GET', '/admin/api/logs?limit=50')
    ]).then(function(results){
      if (gen !== loadGen) return;
      renderOverview(results[0]);
      renderKeys(results[1].keys);
      renderLogs(results[2].logs);
    }).catch(function(err){
      if (gen !== loadGen) return;
      if (err.message !== 'unauthorized') toast('加载失败：' + err.message, true);
    }).finally(function(){
      if (gen === loadGen) loading = false;
    });
  }

  function startTimer(){
    stopTimer();
    timer = setInterval(function(){
      if ($('auto-refresh').checked && !document.hidden) loadAll();
    }, 10000);
  }
  function stopTimer(){
    if (timer) { clearInterval(timer); timer = null; }
  }

  $('login-btn').addEventListener('click', login);
  $('login-pass').addEventListener('keydown', function(event){ if (event.key === 'Enter') login(); });
  $('btn-refresh').addEventListener('click', loadAll);
  $('btn-logout').addEventListener('click', function(){
    localStorage.removeItem(TOKEN_KEY);
    token = '';
    showLogin('');
  });

  $('btn-add-key').addEventListener('click', function(){
    var key = $('new-key').value.trim();
    var label = $('new-label').value.trim();
    if (!key) { toast('请先粘贴 Cursor API Key', true); return; }
    api('POST', '/admin/api/keys', {
      key: key,
      label: label || undefined,
      clientType: $('new-channel').value || 'inherit'
    }).then(function(){
      $('new-key').value = '';
      $('new-label').value = '';
      $('new-channel').value = 'inherit';
      toast('已添加 key');
      loadAll();
    }).catch(function(err){ toast('添加失败：' + err.message, true); });
  });

  $('sand-mode-toggle').addEventListener('change', function(){
    var enabled = $('sand-mode-toggle').checked;
    api('POST', '/admin/api/settings', { sandClientMode: enabled }).then(function(data){
      sandClientMode = !!data.config.sandClientMode;
      $('chip-sand').textContent = '通道：' + (sandClientMode ? 'Sand' : 'SDK');
      toast(sandClientMode ? '已全局切换到 Sand 通道' : '已全局切换到 SDK 通道');
      loadAll();
    }).catch(function(err){
      toast('切换通道失败：' + err.message, true);
      loadAll();
    });
  });

  $('btn-save-settings').addEventListener('click', function(){
    var threshold = parseInt($('auto-disable-threshold').value, 10);
    if (!(threshold >= 1 && threshold <= 50)) { toast('连续失败次数需为 1-50 的整数', true); return; }
    var body = {
      cursorSdkUseHttp1ForAgent: $('sdk-http1-toggle').checked,
      cursorMaxMode: $('max-mode-toggle').checked,
      cursorFast: $('fast-toggle').checked,
      autoDisableKeys: $('auto-disable-toggle').checked,
      autoDisableThreshold: threshold
    };
    var button = $('btn-save-settings');
    button.disabled = true;
    button.textContent = '保存中…';
    api('POST', '/admin/api/settings', body).then(function(data){
      toast('设置已保存');
      $('chip-http1').textContent = 'HTTP：' + (data.config.cursorSdkUseHttp1ForAgent ? '1.1' : '默认');
      $('max-mode-toggle').checked = !!data.config.cursorMaxMode;
      $('fast-toggle').checked = !!data.config.cursorFast;
      autoDisableThreshold = data.config.autoDisableThreshold || 1;
      $('auto-disable-toggle').checked = !!data.config.autoDisableKeys;
      $('auto-disable-threshold').value = autoDisableThreshold;
      sandClientMode = !!data.config.sandClientMode;
      $('sand-mode-toggle').checked = sandClientMode;
      $('chip-sand').textContent = '通道：' + (sandClientMode ? 'Sand' : 'SDK');
      loadAll();
    }).catch(function(err){
      toast('保存设置失败：' + err.message, true);
      loadAll();
    }).finally(function(){
      button.disabled = false;
      button.textContent = '保存设置';
    });
  });

  $('keys-body').addEventListener('change', function(event){
    var select = event.target.closest('select[data-action="channel"]');
    if (!select) return;
    var id = select.getAttribute('data-id');
    var clientType = select.value;
    select.disabled = true;
    api('POST', '/admin/api/keys/' + id + '/channel', { clientType: clientType }).then(function(){
      toast('已切换为' + channelLabel(clientType));
      loadAll();
    }).catch(function(err){
      toast('切换通道失败：' + err.message, true);
      loadAll();
    }).finally(function(){
      select.disabled = false;
    });
  });

  $('keys-body').addEventListener('click', function(event){
    var button = event.target.closest('button[data-action]');
    if (!button) return;
    var id = button.getAttribute('data-id');
    var action = button.getAttribute('data-action');
    if (action === 'up' || action === 'down') {
      moveKey(id, action === 'up' ? -1 : 1);
      return;
    }
    if (action === 'test') {
      testKey(id, button);
      return;
    }
    if (action === 'delete') {
      if (!confirm('确定删除该 key？')) return;
      api('DELETE', '/admin/api/keys/' + id).then(function(){ toast('已删除'); loadAll(); })
        .catch(function(err){ toast(err.message, true); });
      return;
    }
    api('POST', '/admin/api/keys/' + id + '/' + action).then(function(){
      toast(action === 'enable' ? '已启用' : '已禁用');
      loadAll();
    }).catch(function(err){ toast(err.message, true); });
  });

  $('btn-test').addEventListener('click', function(){
    var button = $('btn-test');
    var result = $('test-result');
    button.disabled = true;
    button.textContent = '测试中…';
    result.classList.remove('hidden');
    result.textContent = '请求中，请稍候（首次冷启动可能需 20s+）…';
    api('POST', '/admin/api/test', {
      model: $('test-model').value,
      prompt: $('test-prompt').value
    }).then(function(data){
      if (data.ok) {
        result.textContent = '✔ 成功（' + (data.durationMs / 1000).toFixed(1) + 's，key：' + (data.keyLabel || '-') + '）\\n' + data.text;
      } else {
        result.textContent = '✘ 失败（' + (data.durationMs / 1000).toFixed(1) + 's，key：' + (data.keyLabel || '-') + '）\\n' + data.error;
      }
      loadAll();
    }).catch(function(err){
      result.textContent = '✘ 请求失败：' + err.message;
    }).finally(function(){
      button.disabled = false;
      button.textContent = '发送测试';
    });
  });

  if (token) {
    api('POST', '/admin/api/login').then(function(){
      showApp();
      loadAll();
      startTimer();
    }).catch(function(){ /* showLogin 已在 401 分支处理 */ });
  } else {
    showLogin('');
  }
})();
</script>
</body>
</html>
`;
