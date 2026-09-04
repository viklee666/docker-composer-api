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
<link rel="icon" href="data:,">
<title>Composer API 管理后台</title>
<style>
:root{
  --bg:#0b0f17;--panel:#111726;--panel-2:#161e30;--border:#232d45;
  --text:#e6ebf5;--muted:#8b96ad;--accent:#5b8cff;--accent-2:#36c6b0;
  --green:#2ecc8f;--red:#ff6b6b;--yellow:#f5b84d;
  --radius:14px;--mono:ui-monospace,SFMono-Regular,Consolas,Menlo,monospace;
  --sidebar:248px;
}
*{box-sizing:border-box;margin:0;padding:0}
html,body{height:100%}
body{
  background:radial-gradient(1200px 600px at 80% -10%,#16203a 0%,var(--bg) 55%);
  color:var(--text);min-height:100vh;
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;
}
a{color:var(--accent)}
.hidden{display:none!important}
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
textarea{width:100%;min-height:120px;resize:vertical;line-height:1.5}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:14px;margin-bottom:18px}
.card{background:var(--panel);border:1px solid var(--border);border-radius:var(--radius);padding:16px 18px}
.card .k{color:var(--muted);font-size:12px;margin-bottom:8px;display:flex;align-items:center;gap:6px}
.card .v{font-size:25px;font-weight:700;font-variant-numeric:tabular-nums}
.card .d{color:var(--muted);font-size:12px;margin-top:6px}
.panel{background:var(--panel);border:1px solid var(--border);border-radius:var(--radius);margin-bottom:18px;overflow:hidden}
.panel>.head{display:flex;align-items:center;gap:10px;padding:14px 18px;border-bottom:1px solid var(--border);flex-wrap:wrap}
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
.badge.estimated{background:rgba(245,184,77,.14);color:var(--yellow)}
.badge.missing{background:rgba(139,150,173,.12);color:var(--muted)}
.row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.muted{color:var(--muted)}
.small{font-size:12px}
.err-text{color:var(--red);font-size:11.5px;word-break:break-all}
.empty{color:var(--muted);text-align:center;padding:26px 0;font-size:13px}
/* 操作列的按钮不允许换行：列被挤窄时换行会把按钮竖着堆起来，一行能撑到 200px 以上。 */
.actions{display:flex;gap:6px;flex-wrap:nowrap}
.actions button{padding:4px 10px;font-size:12px;border-radius:7px;white-space:nowrap}
.chip{border:1px solid var(--border);background:var(--panel);border-radius:999px;padding:2px 10px;font-size:11.5px;color:var(--muted)}
.chip.ok{color:var(--green);border-color:rgba(46,204,143,.35)}
.spacer{flex:1}
.logo{width:38px;height:38px;border-radius:11px;background:linear-gradient(135deg,var(--accent),var(--accent-2));
  display:flex;align-items:center;justify-content:center;font-weight:800;font-size:17px;color:#06101f;flex-shrink:0}
#test-result,#cc-chat-result{margin-top:12px;background:#0d1322;border:1px solid var(--border);border-radius:9px;
  padding:12px;font-family:var(--mono);font-size:12.5px;white-space:pre-wrap;word-break:break-all}
.table-scroll{overflow-x:auto}
/*
 * 列多的表（key 池 12 列、请求历史 17 列）必须让表格自己撑开再横向滚动。
 * 基础规则里 table 是 width:100%，那样表格只会压缩到容器宽度，
 * overflow-x 永远不触发，最后把「操作」列挤成几十像素、按钮竖排、整行拉到 200px 高。
 */
.table-scroll table{width:auto;min-width:100%}
.table-scroll td{white-space:nowrap}
/* 错误文本是唯一需要换行的列，否则一条长报错会把表格撑得无限宽。 */
.table-scroll td .err-text{white-space:normal;display:inline-block;max-width:280px}
label.toggle{display:flex;align-items:center;gap:6px;color:var(--muted);font-size:12.5px;cursor:pointer;user-select:none}
.callout{background:var(--panel-2);border:1px solid var(--border);border-left:3px solid var(--accent);border-radius:10px;padding:12px 14px;margin-bottom:14px;font-size:13px;line-height:1.55}
.callout strong{color:#fff}
.callout.warn{border-left-color:var(--yellow)}
.settings-block{margin:0 0 22px}
.settings-block:last-child{margin-bottom:8px}
.settings-block h3{font-size:13px;font-weight:650;margin:0 0 4px}
.settings-block .lede{color:var(--muted);font-size:12px;line-height:1.5;margin-bottom:10px}
.settings-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:12px 16px}
.setting-field label{display:block;font-size:12px;color:var(--muted);margin-bottom:5px}
.setting-field .env{font-family:var(--mono);font-size:11px;color:var(--muted);font-weight:400}
.setting-field .hint{font-size:11.5px;color:var(--muted);margin-top:4px;line-height:1.45}
.setting-field input[type="number"],.setting-field input[type="text"],.setting-field select{width:100%;max-width:100%}
.setting-check{display:flex;align-items:flex-start;gap:8px;font-size:13px;color:var(--text);cursor:pointer}
.setting-check input{margin-top:3px}
.warn-loud{background:rgba(245,184,77,.12);border:1px solid rgba(245,184,77,.55);color:var(--yellow);
  border-radius:12px;padding:14px 16px;margin:12px 0;font-size:13.5px;line-height:1.55}
.warn-loud strong{color:#ffd789}
.note{color:var(--muted);font-size:12.5px;line-height:1.55;margin-top:8px}
.secret-box{background:rgba(46,204,143,.08);border:1px solid rgba(46,204,143,.4);border-radius:12px;padding:14px 16px;margin-bottom:14px}
.secret-box .mono{font-size:13.5px;word-break:break-all}
.config-list{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px}
.config-item{background:var(--panel-2);border:1px solid var(--border);border-radius:10px;padding:10px 12px}
.config-item .k{font-size:11.5px;color:var(--muted);margin-bottom:4px}
.config-item .v{font-size:13.5px}
.weight-input{width:72px;padding:4px 6px;font-size:12px}
.scope-chip{cursor:help;border-bottom:1px dashed var(--border)}
.scope-grid{display:grid;grid-template-columns:1fr 1fr;gap:14px}
.scope-list{max-height:240px;overflow:auto;border:1px solid var(--border);border-radius:10px;padding:8px 10px;background:#0d1322}
.scope-list label{display:flex;align-items:flex-start;gap:8px;padding:4px 0;font-size:12.5px;color:var(--text)}
.bind-list{max-height:280px;overflow:auto;border:1px solid var(--border);border-radius:10px;padding:8px 10px;background:#0d1322}
.bind-list label{display:flex;align-items:flex-start;gap:8px;padding:5px 0;font-size:13px;color:var(--text)}
#login{position:fixed;inset:0;background:var(--bg);display:flex;align-items:center;justify-content:center;z-index:50}
.login-card{width:min(380px,92vw);background:var(--panel);border:1px solid var(--border);border-radius:18px;padding:34px 30px}
.login-card .logo{width:46px;height:46px;font-size:20px;margin-bottom:16px}
.login-card h1{font-size:20px;margin-bottom:6px}
.login-card p{color:var(--muted);font-size:13px;margin-bottom:20px}
.login-card input{width:100%;margin-bottom:12px;padding:11px 13px}
.login-card button{width:100%;padding:11px}
.login-err{color:var(--red);font-size:12.5px;min-height:18px;margin-bottom:8px}
#toast{position:fixed;right:18px;bottom:18px;display:flex;flex-direction:column;gap:8px;z-index:99}
.toast{background:var(--panel-2);border:1px solid var(--border);border-left:3px solid var(--accent);
  border-radius:10px;padding:10px 16px;font-size:13px;box-shadow:0 8px 30px rgba(0,0,0,.45);animation:in .2s ease}
.toast.bad{border-left-color:var(--red)}
@keyframes in{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
#app{min-height:100vh}
.app-shell{display:flex;min-height:100vh}
.sidebar{
  width:var(--sidebar);flex-shrink:0;background:var(--panel);border-right:1px solid var(--border);
  display:flex;flex-direction:column;position:sticky;top:0;height:100vh;z-index:30;
}
.sidebar-brand{display:flex;align-items:center;gap:10px;padding:18px 16px 14px}
.sidebar-brand h1{font-size:14.5px;font-weight:700;letter-spacing:.2px;line-height:1.3}
.sidebar-brand .sub{color:var(--muted);font-size:11.5px;margin-top:2px}
.nav{flex:1;overflow:auto;padding:4px 0 12px}
.nav-group{padding:12px 18px 4px;font-size:11px;color:var(--muted);letter-spacing:.08em}
.nav-item{
  display:block;width:calc(100% - 16px);margin:2px 8px;padding:8px 12px;border:0;background:transparent;
  text-align:left;border-radius:9px;color:var(--text);font-size:13.5px;
}
.nav-item:hover{background:var(--panel-2);border-color:transparent;color:#fff}
.nav-item.active{background:rgba(91,140,255,.16);color:#fff;box-shadow:inset 2px 0 0 var(--accent)}
.sidebar-foot{padding:12px 16px 16px;border-top:1px solid var(--border);font-size:12px;color:var(--muted);line-height:1.55}
.main{flex:1;min-width:0;display:flex;flex-direction:column}
.topbar{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:12px 18px;border-bottom:1px solid var(--border);background:rgba(17,23,38,.88);position:sticky;top:0;z-index:20}
.topbar h2{font-size:16px;font-weight:700}
.topbar .chips{display:flex;gap:6px;flex-wrap:wrap;align-items:center}
.content{padding:18px 20px 56px;flex:1}
.menu-btn{display:none;width:38px;height:38px;padding:0;align-items:center;justify-content:center;font-size:18px}
.sidebar-mask{display:none}
.pager{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-top:12px}
.log-detail{background:#0d1322;border:1px solid var(--border);border-radius:8px;padding:8px 10px;margin-top:6px;font-size:11.5px;color:var(--muted);white-space:pre-wrap;word-break:break-all}
#modal-mask{position:fixed;inset:0;background:rgba(5,8,14,.62);z-index:80;display:flex;align-items:center;justify-content:center;padding:20px}
.modal{width:min(760px,96vw);max-height:90vh;overflow:auto;background:var(--panel);border:1px solid var(--border);border-radius:16px}
.modal .head{display:flex;align-items:center;gap:10px;padding:14px 18px;border-bottom:1px solid var(--border)}
.modal .body{padding:16px 18px}
.modal .foot{display:flex;justify-content:flex-end;gap:8px;padding:12px 18px;border-top:1px solid var(--border)}
@media (max-width:900px){
  .sidebar{position:fixed;left:0;top:0;transform:translateX(-105%);transition:transform .2s ease;box-shadow:8px 0 30px rgba(0,0,0,.4)}
  .sidebar.open{transform:none}
  .sidebar-mask{display:block;position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:25}
  .sidebar-mask.hidden{display:none}
  .menu-btn{display:inline-flex}
  .topbar .chips .chip-extra{display:none}
  .scope-grid{grid-template-columns:1fr}
  .content{padding:14px 12px 48px}
}
@media (max-width:600px){
  .grid{grid-template-columns:1fr 1fr}
  .card .v{font-size:20px}
  .topbar .chips{display:none}
}
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

<div id="app" class="hidden">
  <div class="app-shell">
    <div class="sidebar-mask hidden" id="sidebar-mask"></div>
    <aside class="sidebar" id="sidebar">
      <div class="sidebar-brand">
        <div class="logo">C</div>
        <div>
          <h1>Composer API</h1>
          <div class="sub">管理后台</div>
        </div>
      </div>
      <nav class="nav" id="nav">
        <div class="nav-group">概览</div>
        <button type="button" class="nav-item" data-nav="dashboard">概览</button>
        <div class="nav-group">密钥</div>
        <button type="button" class="nav-item" data-nav="keys">Cursor Key 池</button>
        <button type="button" class="nav-item" data-nav="gateway-keys">网关密钥</button>
        <button type="button" class="nav-item" data-nav="connect">Connect 凭据</button>
        <div class="nav-group">策略</div>
        <button type="button" class="nav-item" data-nav="routing">取用策略与会话粘性</button>
        <button type="button" class="nav-item" data-nav="system-prompt">默认系统提示词</button>
        <button type="button" class="nav-item" data-nav="proxy">代理设置</button>
        <div class="nav-group">运维</div>
        <button type="button" class="nav-item" data-nav="history">请求历史</button>
        <button type="button" class="nav-item" data-nav="diagnostics">联通性测试</button>
        <button type="button" class="nav-item" data-nav="settings">运行设置</button>
      </nav>
      <div class="sidebar-foot">
        <div id="side-version">v-</div>
        <div id="side-uptime">运行 -</div>
      </div>
    </aside>
    <div class="main">
      <header class="topbar">
        <button type="button" class="menu-btn" id="btn-menu" aria-label="打开导航">☰</button>
        <h2 id="crumb">概览</h2>
        <div class="chips">
          <span class="chip ok" id="chip-status">● 运行中</span>
          <span class="chip chip-extra" id="chip-version">v-</span>
          <span class="chip chip-extra" id="chip-uptime">运行 -</span>
          <span class="chip chip-extra" id="chip-direct">直传 key：-</span>
          <span class="chip" id="chip-session">会话：-</span>
          <span class="chip" id="chip-http1">HTTP：-</span>
          <span class="chip" id="chip-autodisable">自动禁用：-</span>
          <span class="chip" id="chip-sand">通道：-</span>
        </div>
        <div class="spacer"></div>
        <label class="toggle"><input type="checkbox" id="auto-refresh" checked> 10s 自动刷新</label>
        <button id="btn-refresh">刷新</button>
        <button id="btn-logout" class="danger">退出</button>
      </header>
      <div class="content">

        <section id="sec-dashboard" data-section="dashboard">
          <div class="grid">
            <div class="card"><div class="k">Cursor Key（可用 / 总数）</div><div class="v" id="st-keys">-</div><div class="d" id="st-keys-d">-</div></div>
            <div class="card hidden" id="card-gw"><div class="k">网关密钥（可用 / 总数）</div><div class="v" id="st-gw">-</div><div class="d" id="st-gw-d">-</div></div>
            <div class="card"><div class="k">总请求数</div><div class="v" id="st-total">-</div><div class="d" id="st-total-d">-</div></div>
            <div class="card"><div class="k">近 24 小时</div><div class="v" id="st-24h">-</div><div class="d" id="st-24h-d">-</div></div>
            <div class="card"><div class="k">平均耗时</div><div class="v" id="st-avg">-</div><div class="d">仅统计已完成请求</div></div>
            <div class="card"><div class="k">Token 实测（累计）</div><div class="v" id="st-tokens">-</div><div class="d" id="st-tokens-d">-</div></div>
            <div class="card"><div class="k">Token 估算（累计）</div><div class="v" id="st-estimated-tokens">-</div><div class="d" id="st-estimated-tokens-d">-</div></div>
            <div class="card"><div class="k">实际花费 chargedCents</div><div class="v" id="st-cost">-</div><div class="d" id="st-cost-d">-</div></div>
          </div>
          <div class="panel">
            <div class="head"><h2>当前配置</h2><span class="hint">来自 overview.config，改完到对应页面保存</span></div>
            <div class="body">
              <div class="config-list" id="cfg-summary"></div>
              <p class="note">chargedCents 单位是美分浮点数（USD cent）。套餐内 / BYOK / 赠额用量的 chargedCents 为 0 是正常现象，不是统计漏记。</p>
            </div>
          </div>
          <div class="panel">
            <div class="head"><h2>Durable 会话</h2><span class="hint">进程内计数，重启清零；不含提示词与完整会话 id</span></div>
            <div class="body">
              <div class="config-list" id="durable-summary"></div>
              <p class="note" id="durable-identity"></p>
              <div class="table-scroll" style="margin-top:12px">
                <table>
                  <thead><tr><th>时间</th><th>决策</th><th>原因</th><th>会话</th><th>增量</th></tr></thead>
                  <tbody id="durable-recent"></tbody>
                </table>
              </div>
            </div>
          </div>
        </section>

        <section id="sec-keys" class="hidden" data-section="keys">
          <div class="panel">
            <div class="head">
              <h2>Cursor Key 池</h2>
              <span class="hint">按下表顺序取第一个可用 key（↑↓ 可调整）；额度不足/失效连续达到阈值才自动禁用并切换下一个，上游临时报错只换下一个不禁用；被禁用的 key 需手动启用。权重仅在 round-robin 策略下生效。</span>
            </div>
            <div class="body">
              <div class="row" style="margin-bottom:14px">
                <input id="new-key" placeholder="粘贴 Cursor API Key（crsr_...）" style="flex:2;min-width:220px" autocomplete="off">
                <input id="new-label" placeholder="备注（可选）" style="flex:1;min-width:120px" autocomplete="off">
                <select id="new-channel" style="min-width:120px" title="该 key 的 Cursor 通道">
                  <option value="inherit">跟随全局</option>
                  <option value="sdk">强制 SDK</option>
                  <option value="sand">强制 Sand</option>
                </select>
                <input id="new-weight" class="weight-input" type="number" min="1" max="1000000" step="1" value="1" title="权重，仅 round-robin 生效" style="width:88px">
                <button class="primary" id="btn-add-key">添加 Key</button>
              </div>
              <div class="row" style="margin-bottom:14px">
                <input id="new-allowed" placeholder="初始白名单（可选，逗号分隔模型 id）" style="flex:1;min-width:200px" autocomplete="off">
                <input id="new-excluded" placeholder="初始黑名单（可选，逗号分隔模型 id）" style="flex:1;min-width:200px" autocomplete="off">
              </div>
              <div class="table-scroll">
                <table>
                  <thead><tr>
                    <th>优先级</th><th>备注</th><th>掩码 key</th><th>状态</th><th>通道</th><th>可用模型范围</th><th>权重</th><th>请求数</th><th>失败数</th><th>最后使用</th><th>最后错误</th><th>操作</th>
                  </tr></thead>
                  <tbody id="keys-body"></tbody>
                </table>
              </div>
              <div class="empty hidden" id="keys-empty">暂无 key，请添加或在 .env 配置 CURSOR_API_KEYS</div>
            </div>
          </div>
          <div class="panel">
            <div class="head"><h2>用 Session Token 铸造 Key</h2><span class="hint">只把 WorkosCursorSessionToken 用一次来换 API key，网关不会保存这段会话凭据</span></div>
            <div class="body">
              <p class="note" style="margin-top:0;margin-bottom:12px">到 cursor.com 打开开发者工具，复制 cookie <span class="mono">WorkosCursorSessionToken</span> 的值并粘贴到下方。这是<strong>完整账号凭据</strong>：网关只用它铸造一把 API key，然后立即丢弃，不会写入数据库或日志。备注可选，留空时由网关生成一个带 UTC 时间戳与随机后缀的名字。</p>
              <textarea id="mint-token" placeholder="粘贴 WorkosCursorSessionToken" autocomplete="off" spellcheck="false" style="-webkit-text-security:disc"></textarea>
              <div class="row" style="margin-top:10px">
                <input id="mint-name" placeholder="备注 / 名称（可选，自动生成）" style="flex:1;min-width:180px" autocomplete="off">
                <label class="toggle"><input type="checkbox" id="mint-show"> 显示凭据</label>
                <button class="primary" id="btn-mint">铸造并入库</button>
              </div>
            </div>
          </div>
        </section>

        <section id="sec-gateway-keys" class="hidden" data-section="gateway-keys">
          <div class="panel">
            <div class="head"><h2>网关密钥</h2><span class="hint">客户端调用本网关时使用的入站密钥；列表永远只返回掩码</span></div>
            <div class="body">
              <div id="gw-unwired" class="empty hidden">当前进程未接入网关多密钥池（overview.gatewayKeys 不存在）。单密钥模式请继续用 GATEWAY_API_KEY，无需在此配置。</div>
              <div id="gw-wired">
                <div id="gw-reveal" class="secret-box hidden">
                  <div class="k" style="margin-bottom:8px;color:var(--yellow)">完整密钥只显示这一次，关闭或刷新后无法再查看</div>
                  <div class="mono" id="gw-reveal-key"></div>
                  <div class="row" style="margin-top:10px">
                    <button type="button" id="btn-copy-gw">复制</button>
                    <button type="button" id="btn-hide-gw">我已保存</button>
                  </div>
                </div>
                <div class="row" style="margin-bottom:14px">
                  <input id="new-gw-label" placeholder="备注（可选）" style="flex:1;min-width:140px" autocomplete="off">
                  <input id="new-gw-key" placeholder="粘贴自定义密钥；留空则自动生成" style="flex:2;min-width:220px" autocomplete="off">
                  <button class="primary" id="btn-add-gw">创建网关密钥</button>
                </div>
                <div class="table-scroll">
                  <table>
                    <thead><tr>
                      <th>备注</th><th>掩码 key</th><th>状态</th><th>来源</th><th>可用 Cursor Key</th><th>模型范围</th><th>请求数</th><th>最后使用</th><th>操作</th>
                    </tr></thead>
                    <tbody id="gw-body"></tbody>
                  </table>
                </div>
                <div class="empty hidden" id="gw-empty">暂无网关密钥</div>
              </div>
            </div>
          </div>
        </section>

        <section id="sec-connect" class="hidden" data-section="connect">
          <div class="panel">
            <div class="head">
              <h2>Cursor Connect 凭据</h2>
              <span class="hint">Connect 直连 <code>aiserver.v1.InferenceService/Stream</code>。凭据优先从 Cursor Key 池兑换；也可以继续粘贴桌面端 session JWT。与 SDK 路线的运行时互不共用。</span>
            </div>
            <div class="body">
              <div class="callout" id="connect-status-box">
                <strong id="connect-status-title">正在读取状态…</strong>
                <span id="connect-status-detail"></span>
              </div>
              <div class="callout warn">
                <strong>设备标识必须稳定</strong>
                同一份凭据的 machineId 在整个生命周期内不能变，否则上游会把它当成另一台设备。留空会自动生成一个并永久保存，不要每次都填新的。
                <br>凭据只能写入、不能读回：后台不回传 token 明文，只显示首尾各 4 位用于辨认。
              </div>
              <div class="row" style="margin-bottom:10px">
                <select id="cc-from-key" style="flex:2;min-width:240px" title="从 Cursor Key 池兑换 session token">
                  <option value="">选择一把 Cursor Key</option>
                </select>
                <button class="primary" id="btn-cc-from-key">从 Key 拉取</button>
              </div>
              <p class="note" style="margin-top:0;margin-bottom:12px">用 Key 池里的 <code>crsr_</code> 向 Cursor 兑换 session JWT，不必从桌面端粘贴。同一把 key 再拉取会换新 token、保持原 machineId。下面的粘贴框只留给没有入池的 token。</p>
              <div class="row" style="margin-bottom:14px">
                <input id="cc-token" placeholder="粘贴 Cursor session token（JWT）" style="flex:2;min-width:240px" autocomplete="off">
                <input id="cc-label" placeholder="备注（可选）" style="flex:1;min-width:120px" autocomplete="off">
                <input id="cc-machine" placeholder="machineId（留空自动生成）" style="flex:1;min-width:160px" autocomplete="off">
                <button class="primary" id="btn-cc-add">添加凭据</button>
              </div>
              <div class="table-scroll">
                <table>
                  <thead><tr>
                    <th>备注</th><th>token</th><th>类型</th><th>设备</th><th>版本</th><th>状态</th><th>失败数</th><th>最后使用</th><th>操作</th>
                  </tr></thead>
                  <tbody id="cc-body"></tbody>
                </table>
              </div>
              <div class="empty hidden" id="cc-empty">暂无 Connect 凭据。加一把之后这条路线才会出现在选路里。</div>
            </div>
          </div>

          <div class="panel">
            <div class="head">
              <h2>对话测试</h2>
              <span class="hint">真正打 <code>InferenceService/Stream</code>，会消耗额度。上面凭据行的「测试」只探 AvailableModels，不能证明聊天可用。</span>
            </div>
            <div class="body">
              <div class="row">
                <select id="cc-test-model" style="min-width:200px" title="来自 Connect 目录；目录还没拉到时默认 grok-4.6"></select>
                <input id="cc-test-prompt" value="Reply with exactly: pong" style="flex:1;min-width:220px">
                <button class="primary" id="btn-cc-chat">发送测试</button>
              </div>
              <div id="cc-chat-result" class="hidden"></div>
            </div>
          </div>

          <div class="panel">
            <div class="head">
              <h2>运行设置</h2>
              <span class="hint">这些值来自环境变量，改完需要重启进程。这里只做回显，避免后台改了却与实际出站不一致。</span>
            </div>
            <div class="body">
              <div class="table-scroll">
                <table>
                  <thead><tr><th>项</th><th>当前值</th><th>env</th></tr></thead>
                  <tbody id="cc-settings-body"></tbody>
                </table>
              </div>
            </div>
          </div>

          <div class="panel">
            <div class="head">
              <h2>模型目录</h2>
              <span class="hint">来自 <code>AiService/AvailableModels</code>，不是硬编码。参数定义是 effort/thinking 等参数值域的权威来源。</span>
            </div>
            <div class="body">
              <div class="row" style="margin-bottom:12px">
                <button id="btn-cc-models">拉取目录</button>
                <button id="btn-cc-models-refresh">强制刷新</button>
                <span class="hint" id="cc-models-hint"></span>
              </div>
              <div class="table-scroll">
                <table>
                  <thead><tr><th>模型</th><th>显示名</th><th>上下文</th><th>能力</th><th>参数</th><th>状态</th></tr></thead>
                  <tbody id="cc-models-body"></tbody>
                </table>
              </div>
              <div class="empty hidden" id="cc-models-empty">还没有拉取过目录</div>
            </div>
          </div>

          <div class="panel">
            <div class="head">
              <h2>Run 列表</h2>
              <span class="hint">只有走工具循环 / background 的请求才会落 run。普通一问一答不建 run。</span>
            </div>
            <div class="body">
              <div class="row" style="margin-bottom:12px">
                <button id="btn-cc-runs">刷新 Run</button>
                <span class="hint" id="cc-runs-hint"></span>
              </div>
              <div class="table-scroll">
                <table>
                  <thead><tr><th>run</th><th>模型</th><th>状态</th><th>交付</th><th>尝试</th><th>事件</th><th>开始</th><th>操作</th></tr></thead>
                  <tbody id="cc-runs-body"></tbody>
                </table>
              </div>
              <div class="empty hidden" id="cc-runs-empty">暂无 run</div>
              <pre id="cc-run-detail" class="hidden" style="margin-top:14px;max-height:320px;overflow:auto;background:var(--panel-2);padding:12px;border-radius:8px;font-size:12px"></pre>
            </div>
          </div>
        </section>

        <section id="sec-routing" class="hidden" data-section="routing">
          <div class="panel">
            <div class="head"><h2>取用策略与会话粘性</h2><span class="hint">保存后立即作用于后续选 key</span></div>
            <div class="body">
              <div class="callout">
                <strong>为什么默认是 fill-first？</strong>
                Cursor 按「哪把 key」缓存 prompt。轮换 key 会丢掉这段缓存，长上下文会被重新计费。
                所以默认吃满第一把可用 key，而不是轮询。只有在你明确要摊平多把 key 的用量时，才改用 round-robin。
              </div>
              <div class="row" style="margin-bottom:14px">
                <label class="toggle" style="color:var(--text);font-size:13px"><input type="radio" name="routing-strategy" value="fill-first"> fill-first（吃满第一把，保缓存）</label>
                <label class="toggle" style="color:var(--text);font-size:13px"><input type="radio" name="routing-strategy" value="round-robin"> round-robin（按权重轮询）</label>
              </div>
              <p class="note" style="margin-top:0;margin-bottom:14px">round-robin 才看各 key 的权重（1–1000000）。fill-first 下权重不参与挑选。</p>
              <div class="callout warn">
                <strong>会话粘性</strong>
                把同一段对话钉在上次成功服务它的那把 key 上，让上游缓存保持热。
                绑定的 key 被禁用、删除、或不在该模型的允许范围内时，会自动回退到当前策略重新选 key。
              </div>
              <div class="row" style="margin-bottom:12px">
                <label class="toggle" style="color:var(--text);font-size:13px"><input type="checkbox" id="affinity-toggle"> 启用会话粘性</label>
                <label class="toggle" style="color:var(--text);font-size:13px">TTL
                  <input id="affinity-ttl" type="number" min="1000" step="1000" style="width:140px;padding:6px 8px">
                  ms（最小 1000）
                </label>
              </div>
              <button class="primary" id="btn-save-routing">保存策略</button>
            </div>
          </div>
        </section>

        <section id="sec-system-prompt" class="hidden" data-section="system-prompt">
          <div class="panel">
            <div class="head"><h2>默认系统提示词</h2><span class="hint">注入到合成后的 prompt 里，因为 SDK 没有 system-prompt 参数</span></div>
            <div class="body">
              <p class="note" style="margin-top:0;margin-bottom:12px">append：接在客户端自己的 system 之后。override：整段替换客户端 system。正文留空时<strong>不会</strong>把客户端的 system 洗成空白，只是网关不再注入。后端上限约 32000 字。</p>
              <div class="row" style="margin-bottom:10px">
                <label class="toggle" style="color:var(--text)">模式
                  <select id="sys-mode">
                    <option value="off">off（不注入）</option>
                    <option value="append">append（追加）</option>
                    <option value="override">override（覆盖）</option>
                  </select>
                </label>
                <span class="muted small" id="sys-count">0 / 32000</span>
                <span class="muted small" id="sys-set-hint"></span>
              </div>
              <textarea id="sys-text" placeholder="默认系统提示词正文" maxlength="32000"></textarea>
              <div class="row" style="margin-top:12px">
                <button class="primary" id="btn-save-sys">保存提示词</button>
                <button type="button" id="btn-load-sys">重新载入</button>
              </div>
              <p class="note">进入本页会自动载入已保存的正文（GET /admin/api/system-prompt）。正文没塞进 overview 是因为后台每 10 秒轮询一次它，而提示词可以有几万字。</p>
            </div>
          </div>
        </section>

        <section id="sec-proxy" class="hidden" data-section="proxy">
          <div class="panel">
            <div class="head"><h2>代理设置</h2><span class="hint">支持 http / https / socks5 / socks5h / socks4；只写 host:port 时默认 http；可内嵌用户名密码</span></div>
            <div class="body">
              <div class="row" style="margin-bottom:12px">
                <input id="proxy-url" placeholder="http://127.0.0.1:7890 或 socks5h://user:pass@host:1080" style="flex:1;min-width:260px" autocomplete="off">
                <button class="primary" id="btn-save-proxy">保存代理</button>
                <button type="button" id="btn-test-proxy">测试代理</button>
              </div>
              <p class="note" style="margin-top:0">留空并保存即关闭代理。状态里的 URL 已掩码，不会回显密码。保存代理时会自动打开「HTTP/1.1」——HTTP/2 不支持代理，不开的话模型流量会绕过代理直连；只有你显式关过这个开关时才会尊重你的选择。「测试代理」会分别探云端 REST 与模型两条链路：它们是两套不同的客户端、两个不同的 host，REST 通不代表模型通。</p>
              <div id="proxy-status"></div>
              <div id="proxy-test-result" class="hidden" style="margin-top:12px"></div>
            </div>
          </div>
        </section>

        <section id="sec-history" class="hidden" data-section="history">
          <div class="panel">
            <div class="head">
              <h2>请求历史</h2>
              <span class="hint" id="hist-hint">服务端分页</span>
              <div class="spacer"></div>
              <button class="danger" id="btn-clear-logs">清空历史</button>
            </div>
            <div class="body">
              <div class="row" style="margin-bottom:12px">
                <select id="log-key" style="min-width:140px"><option value="">全部 Cursor Key</option></select>
                <select id="log-gw" style="min-width:140px"><option value="">全部网关密钥</option></select>
                <select id="log-model" style="min-width:160px"><option value="">全部模型</option></select>
                <select id="log-outcome" style="min-width:110px">
                  <option value="">全部结果</option>
                  <option value="success">成功</option>
                  <option value="error">失败</option>
                </select>
                <select id="log-since" style="min-width:120px">
                  <option value="">全部时间</option>
                  <option value="1h">近 1 小时</option>
                  <option value="24h">近 24 小时</option>
                  <option value="7d">近 7 天</option>
                </select>
                <select id="log-limit" style="min-width:90px">
                  <option value="50">50 / 页</option>
                  <option value="100" selected>100 / 页</option>
                  <option value="200">200 / 页</option>
                  <option value="500">500 / 页</option>
                </select>
                <button id="btn-log-apply">筛选</button>
                <button id="btn-log-clear">清空条件</button>
              </div>
              <div class="table-scroll">
                <table>
                  <thead><tr>
                    <th>时间</th><th>端点</th><th>模型</th><th>鉴权方式</th><th>Cursor Key</th><th>网关密钥</th>
                    <th>状态</th><th>耗时</th><th>流式</th><th>推理强度</th><th>Fast</th><th>1M/Max</th>
                    <th>通道</th><th>模式</th><th>token 用量</th><th>花费</th><th>错误</th>
                  </tr></thead>
                  <tbody id="logs-body"></tbody>
                </table>
              </div>
              <div class="empty hidden" id="logs-empty">暂无请求记录</div>
              <div class="pager">
                <button id="btn-log-prev">上一页</button>
                <span class="muted small" id="log-page">—</span>
                <button id="btn-log-next">下一页</button>
              </div>
            </div>
          </div>
        </section>

        <section id="sec-diagnostics" class="hidden" data-section="diagnostics">
          <div class="panel">
            <div class="head"><h2>联通性测试</h2><span class="hint">会真实消耗额度。逐个验证某把 Cursor Key 请用 Key 池表格每行的「测试」</span></div>
            <div class="body">
              <div class="row">
                <select id="test-provider" style="min-width:160px" title="SDK 走密钥池；Connect 走 Connect 凭据">
                  <option value="sdk">SDK（密钥池）</option>
                  <option value="connect">Connect</option>
                </select>
                <select id="test-model" style="min-width:180px"></select>
                <input id="test-prompt" value="Reply with exactly: pong" style="flex:1;min-width:220px">
                <button class="primary" id="btn-test">发送测试</button>
              </div>
              <p class="note" id="test-route-hint" style="margin-top:10px">下方按钮走密钥池（测当前队首可用 key）。</p>
              <div id="test-result" class="hidden"></div>
            </div>
          </div>
        </section>

        <section id="sec-settings" class="hidden" data-section="settings">
          <div class="panel">
            <div class="head"><h2>运行设置</h2><span class="hint">保存到数据库，立即作用于后续请求；启动项（监听地址、库路径）只读，改 env 后重启</span></div>
            <div class="body">
              <div class="settings-block">
                <h3>会话与 prompt 缓存</h3>
                <p class="lede">durable 才复用本地 Agent、打得中上游 prefix cache。<code>sessionMode</code> 必须是 durable；stateless 时 Cache Read 恒为 0，模型会像失忆一样重开每轮。Grok 的 Cache Write=0 是正常的。</p>
                <div class="settings-grid">
                  <div class="setting-field">
                    <label>会话模式 <span class="env">CURSOR_SDK_SESSION_MODE</span></label>
                    <select id="session-mode">
                      <option value="durable">durable（复用 Agent，增量发送）</option>
                      <option value="stateless">stateless（每请求新建，等同 kill switch）</option>
                    </select>
                    <div class="hint">Claude Code 主会话认 x-claude-code-session-id；子代理再带 x-claude-code-agent-id，不会抢同一槽。</div>
                  </div>
                  <div class="setting-field">
                    <label>挂起工具最长等待（ms） <span class="env">CURSOR_SDK_TOOL_HOLD_TTL_MS</span></label>
                    <input id="tool-hold-ttl" type="number" min="1000" step="1000">
                  </div>
                  <div class="setting-field">
                    <label>空闲 Agent 回收（ms） <span class="env">CURSOR_SDK_SESSION_IDLE_TTL_MS</span></label>
                    <input id="session-idle-ttl" type="number" min="10000" step="1000">
                  </div>
                  <div class="setting-field">
                    <label>同时存活会话上限 <span class="env">CURSOR_SDK_MAX_LIVE_SESSIONS</span></label>
                    <input id="max-live-sessions" type="number" min="1" max="10000" step="1">
                  </div>
                </div>
              </div>

              <div class="settings-block">
                <h3>请求与鉴权</h3>
                <div class="settings-grid">
                  <div class="setting-field">
                    <label class="setting-check"><input type="checkbox" id="allow-direct-toggle"> 允许客户端直传 Cursor API key <span class="env">ALLOW_DIRECT_CURSOR_KEYS</span></label>
                  </div>
                  <div class="setting-field">
                    <label class="setting-check"><input type="checkbox" id="builtin-tools-toggle"> 允许网关容器内使用 Cursor 内置工具 <span class="env">CURSOR_ALLOW_BUILTIN_TOOLS</span></label>
                    <div class="hint">默认关。打开后 agent 能在网关侧跑 shell/edit，再转发给客户端会双重执行。</div>
                  </div>
                  <div class="setting-field">
                    <label>上游空闲超时（ms） <span class="env">REQUEST_TIMEOUT_MS</span></label>
                    <input id="request-timeout" type="number" min="5000" step="1000">
                    <div class="hint">流式按无输出空闲计时，每写出一个 SSE chunk 重置。</div>
                  </div>
                  <div class="setting-field">
                    <label>请求历史保留条数 <span class="env">REQUEST_LOG_KEEP</span></label>
                    <input id="request-log-keep" type="number" min="0" step="1">
                    <div class="hint">0 = 不裁剪。条数过大时状态库会一直涨。</div>
                  </div>
                  <div class="setting-field">
                    <label>单次最多轮换 key 次数 <span class="env">MAX_KEY_ATTEMPTS</span></label>
                    <input id="max-key-attempts" type="number" min="1" max="100" step="1">
                  </div>
                  <div class="setting-field">
                    <label>软失败最多重试 <span class="env">MAX_TRANSIENT_KEY_ATTEMPTS</span></label>
                    <input id="max-transient-attempts" type="number" min="1" max="50" step="1">
                  </div>
                </div>
              </div>

              <div class="settings-block">
                <h3>模型默认（客户端显式指定时以客户端为准）</h3>
                <div class="settings-grid">
                  <div class="setting-field">
                    <label>Fast 策略 <span class="env">CURSOR_FAST</span></label>
                    <select id="fast-policy">
                      <option value="passthrough">默认关闭（客户端可覆盖）</option>
                      <option value="force-all">全部支持的模型强制开启</option>
                      <option value="force-selected">仅下列模型强制开启</option>
                    </select>
                    <div class="hint">「默认关闭」= 客户端没表态时网关下发 fast=false，不是「不管」：省略参数会让上游按目录默认档计费（Composer / Grok 的默认档就是 Fast）。请求里显式指定仍以客户端为准。</div>
                  </div>
                  <div class="setting-field">
                    <label>Max Mode 策略 <span class="env">CURSOR_MAX_MODE</span></label>
                    <select id="max-mode-policy">
                      <option value="passthrough">默认关闭（客户端可覆盖）</option>
                      <option value="force-all">全部支持的模型强制开启</option>
                      <option value="force-selected">仅下列模型强制开启</option>
                    </select>
                    <div class="hint">「默认关闭」会下发最小 context 档位（Claude / GPT 目录默认档常为 1M，省略参数仍按 1M 计费）。Claude Code 用 anthropic-beta: context-1m 或模型后缀 [1m] 仍能开。GPT 的 1M 与 Fast 不能共存时 Max Mode 优先。</div>
                  </div>
                  <div class="setting-field hidden" id="fast-models-field">
                    <label>强制开启 Fast 的模型</label>
                    <div class="scope-list" id="fast-models-list"></div>
                    <div class="row" style="margin-top:8px">
                      <input id="fast-models-extra" placeholder="目录外的模型 id" style="flex:1">
                      <button type="button" id="fast-models-add">添加</button>
                    </div>
                  </div>
                  <div class="setting-field hidden" id="max-mode-models-field">
                    <label>强制开启 Max Mode 的模型</label>
                    <div class="scope-list" id="max-mode-models-list"></div>
                    <div class="row" style="margin-top:8px">
                      <input id="max-mode-models-extra" placeholder="目录外的模型 id" style="flex:1">
                      <button type="button" id="max-mode-models-add">添加</button>
                    </div>
                  </div>
                  <div class="setting-field">
                    <label>默认思考强度 <span class="env">CURSOR_REASONING_EFFORT</span></label>
                    <select id="reasoning-effort">
                      <option value="">未设置（跟客户端 / 模型）</option>
                      <option value="none">none</option>
                      <option value="low">low</option>
                      <option value="medium">medium</option>
                      <option value="high">high</option>
                      <option value="xhigh">xhigh</option>
                      <option value="max">max</option>
                    </select>
                  </div>
                  <div class="setting-field">
                    <label>默认 Cursor 会话模式 <span class="env">CURSOR_AGENT_MODE</span></label>
                    <select id="agent-mode">
                      <option value="">未设置</option>
                      <option value="agent">agent</option>
                      <option value="plan">plan</option>
                    </select>
                  </div>
                  <div class="setting-field">
                    <label>默认 model.params <span class="env">CURSOR_MODEL_PARAMS</span></label>
                    <input id="model-params" type="text" placeholder="id=value,id2=value2 或 JSON 数组" autocomplete="off">
                    <div class="hint">显式 params 优先级最高（高于两侧策略），fast=true 会盖过 Fast 策略。</div>
                  </div>
                </div>
              </div>

              <div class="settings-block">
                <h3>通道、协议与自动禁用</h3>
              <div class="row" style="margin-bottom:10px">
                <label class="toggle" style="font-size:13px;color:var(--text)">Cursor local agent 的 HTTP/1.1 + SSE
                  <select id="sdk-http1-mode" style="min-width:210px" title="HTTP/2 不支持代理，配了代理时模型流量必须走 HTTP/1.1">
                    <option value="auto">未设置（配了代理就自动开）</option>
                    <option value="on">强制开启</option>
                    <option value="off">强制关闭</option>
                  </select>
                </label>
                <span class="muted small" id="sdk-http1-hint"></span>
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
              </div>
              <div class="row">
                <button id="btn-save-settings">保存设置</button>
                <span class="muted small">Fast / Max Mode 各自三态独立：默认关闭 = 客户端未表态时网关下发显式关（fast=false / 最小 context），不是「不管」——省略参数会让上游按目录默认档计费（Composer / Grok 默认档就是 Fast、Claude / GPT 默认档常是 1M）；强制开启只对支持对应参数的模型生效（composer 没有 context 档位，Max Mode 对它是空操作）。部分模型（如 GPT-5.x）1M 与 fast 不能共存，此时按模型的合法组合自动取舍，Max Mode 优先。客户端在请求里显式指定（请求体 / x-cursor-* 头 / 模型后缀 / 显式 model.params）时以客户端为准。HTTP/1.1 是三态的：保持「未设置」就交给网关按有没有代理决定（HTTP/2 不支持代理，模型流量只有走 HTTP/1.1 才进得了代理），选了强制开/关就以你的选择为准、网关不再插手；从强制态改回「未设置」会清掉这条设置，重新跟随环境变量与代理。关闭自动禁用后，出错的 key 只会本次跳过、永远不会被自动停用（需自己盯着额度）；计数按连续失败算，成功一次即清零。Sand 通道只改 client-type 头，走 Grok Bot 额度，不解除账号级限制（发票 / hard limit / Grok 额度）。总开关作用于所有「跟随全局」的 key；单个 key 可强制 SDK 或 Sand。</span>
              </div>
            </div>
          </div>
          <div class="panel">
            <div class="head"><h2>启动环境（只读）</h2><span class="hint">改这些必须改 env / compose 后重启进程</span></div>
            <div class="body">
              <div class="table-scroll">
                <table>
                  <thead><tr><th>项</th><th>当前值</th><th>env</th></tr></thead>
                  <tbody id="boot-env-body"></tbody>
                </table>
              </div>
            </div>
          </div>
        </section>

      </div>
    </div>
  </div>
</div>

<div id="modal-mask" class="hidden">
  <div class="modal" role="dialog" aria-modal="true">
    <div class="head"><h2 id="modal-title">编辑</h2><div class="spacer"></div><button type="button" id="modal-close">关闭</button></div>
    <div class="body" id="modal-body"></div>
    <div class="foot">
      <button type="button" id="modal-cancel">取消</button>
      <button type="button" class="primary" id="modal-save">保存</button>
    </div>
  </div>
</div>

<div id="toast"></div>

<script>
(function(){
  'use strict';
  var TOKEN_KEY = 'composer_admin_token';
  var SECTION_KEY = 'composer_admin_section';
  // 与后端 NO_KEY_SENTINEL 一致：绑定的 Cursor key 被删光后写进绑定列表的「全禁」标记。
  // 前端必须认得它，否则会把它当成一个普通 key id 渲染，保存时又被「没勾选=不限制」悄悄抹成整池可用。
  var NO_KEY_SENTINEL = '\\u0000none';
  var token = localStorage.getItem(TOKEN_KEY) || '';
  var timer = null;
  var loading = false;
  var lastKeys = [];
  var lastGwKeys = [];
  var lastOverview = null;
  var lastProxy = null;
  var modelCatalog = [];
  var connectCatalog = [];
  var autoDisableThreshold = 1;
  var sandClientMode = false;
  var gwPoolEnabled = false;
  var revealedGwKey = '';
  var currentSection = 'dashboard';
  var logOffset = 0;
  var logLimit = 100;
  var logTotal = 0;
  var modalState = null;
  var http1ModeDirty = false;

  var SECTIONS = {
    dashboard: '概览',
    keys: 'Cursor Key 池',
    'gateway-keys': '网关密钥',
    connect: 'Connect 凭据',
    routing: '取用策略与会话粘性',
    'system-prompt': '默认系统提示词',
    proxy: '代理设置',
    history: '请求历史',
    diagnostics: '联通性测试',
    settings: '运行设置'
  };

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
      applyInitialSection();
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
  function fmtNum(n){
    if (n == null || n === '') return '—';
    var x = Number(n);
    if (!isFinite(x)) return '—';
    return String(x);
  }
  function fmtUsdFromCents(cents){
    if (cents == null || !isFinite(Number(cents))) return '—';
    return '$' + (Number(cents) / 100).toFixed(4);
  }
  function boolMark(v){
    if (v === true) return '是';
    if (v === false) return '否';
    return '—';
  }
  function parseCsv(text){
    return String(text || '').split(/[,\\n;]+/).map(function(s){ return s.trim(); }).filter(Boolean);
  }
  function modelIds(){
    return modelCatalog.map(function(m){ return m.id; });
  }
  function connectModelIds(){
    var ids = connectCatalog.map(function(m){ return m.id; });
    return ids.length ? ids : ['grok-4.6'];
  }
  function testProvider(){
    var sel = $('test-provider');
    return sel && sel.value === 'connect' ? 'connect' : 'sdk';
  }
  function fillSelect(select, ids, emptyLabel){
    if (!select) return;
    var current = select.value;
    var html = '';
    if (emptyLabel != null) html += '<option value="">' + esc(emptyLabel) + '</option>';
    (ids || []).forEach(function(id){
      html += '<option value="' + esc(id) + '">' + esc(id) + '</option>';
    });
    select.innerHTML = html;
    if (current) {
      var found = false;
      for (var i = 0; i < select.options.length; i++) {
        if (select.options[i].value === current) { found = true; break; }
      }
      if (!found) {
        var extra = document.createElement('option');
        extra.value = current;
        extra.textContent = current;
        select.appendChild(extra);
      }
      select.value = current;
    }
  }
  function fillModelSelects(){
    if (testProvider() === 'connect') fillSelect($('test-model'), connectModelIds(), null);
    else fillSelect($('test-model'), modelIds(), null);
    fillSelect($('log-model'), modelIds(), '全部模型');
  }
  function fillCcChatModels(){
    var sel = $('cc-test-model');
    if (!sel) return;
    var before = sel.value;
    fillSelect(sel, connectModelIds(), null);
    if (before) return;
    connectCatalog.forEach(function(m){
      if (m.defaultOn) sel.value = m.id;
    });
  }
  function updateTestRouteHint(){
    var hint = $('test-route-hint');
    if (!hint) return;
    hint.textContent = testProvider() === 'connect'
      ? '走 Connect 凭据（InferenceService/Stream），不经过 Cursor Key 池。请先在 Connect 凭据页拉好 token。'
      : '下方按钮走密钥池（测当前队首可用 key）。';
  }
  function setModelCatalog(data){
    var list = (data && data.models) ? data.models : [];
    modelCatalog = list.map(function(m){
      return typeof m === 'string'
        ? { id: m, name: m, parameters: [] }
        : { id: m.id, name: m.name || m.id, parameters: m.parameters || [] };
    });
    fillModelSelects();
    // 目录数据晚到 / 轮询刷新都会重建列表：先把 DOM 里的勾选现状收集回来，
    // 否则用户刚勾的会被旧的 policySelected 静默洗掉，之后点保存就存进洗掉的状态。
    syncPolicySelection('fast');
    syncPolicySelection('max-mode');
    renderPolicyModels('fast');
    renderPolicyModels('max-mode');
  }

  function applyInitialSection(){
    var fromHash = (location.hash || '').replace(/^#\\/?/, '');
    var stored = localStorage.getItem(SECTION_KEY) || '';
    var name = SECTIONS[fromHash] ? fromHash : (SECTIONS[stored] ? stored : 'dashboard');
    showSection(name, true);
  }
  function showSection(name, writeHash){
    if (!SECTIONS[name]) name = 'dashboard';
    currentSection = name;
    localStorage.setItem(SECTION_KEY, name);
    if (writeHash !== false) {
      var want = '#/' + name;
      if (location.hash !== want) location.hash = want;
    }
    var nodes = document.querySelectorAll('[data-section]');
    for (var i = 0; i < nodes.length; i++) {
      nodes[i].classList.toggle('hidden', nodes[i].getAttribute('data-section') !== name);
    }
    var navs = document.querySelectorAll('.nav-item');
    for (var j = 0; j < navs.length; j++) {
      navs[j].classList.toggle('active', navs[j].getAttribute('data-nav') === name);
    }
    $('crumb').textContent = SECTIONS[name];
    closeMenu();
    if (name === 'system-prompt') hydrateSystemPrompt();
    if (name === 'history') loadLogs();
    if (name === 'proxy') loadProxy();
    if (name === 'connect') loadConnect();
  }

  /* ------------------------------------------------ Cursor Connect 面板 */

  var CC_SETTING_ROWS = [
    ['默认 provider', 'defaultProvider', 'GATEWAY_PROVIDER'],
    ['出站 base URL', 'baseUrl', 'CURSOR_CONNECT_BASE_URL'],
    ['编码', 'codec', 'CURSOR_CONNECT_CODEC'],
    ['单帧上限', 'readMaxBytes', 'CURSOR_CONNECT_MAX_FRAME_BYTES'],
    ['向上游声明工具', 'sendTools', 'CURSOR_CONNECT_SEND_TOOLS'],
    ['本地工具白名单', 'localTools', 'CURSOR_CONNECT_LOCAL_TOOLS'],
    ['网关子代理', 'subagents', 'CURSOR_CONNECT_SUBAGENTS'],
    ['background worker', 'background', 'CURSOR_CONNECT_BACKGROUND'],
    ['客户端版本', 'clientVersion', 'CURSOR_CONNECT_CLIENT_VERSION']
  ];

  function loadConnect(){
    api('GET', '/admin/api/connect').then(function(data){
      renderConnectStatus(data);
      renderConnectSettings(data.settings || {});
      renderConnectCredentials(data.credentials || []);
      fillCcKeySelect(Array.isArray(data.cursorKeys) ? data.cursorKeys : lastKeys);
      if (data.status && data.status.available) loadConnectModels(false);
      else fillCcChatModels();
    }).catch(function(err){
      $('connect-status-title').textContent = '读取失败';
      $('connect-status-detail').textContent = err.message;
    });
  }

  function fillCcKeySelect(keys){
    var sel = $('cc-from-key');
    if (!sel) return;
    var current = sel.value;
    var list = keys || [];
    var opts = ['<option value="">' + (list.length ? '选择一把 Cursor Key' : 'Key 池是空的，请先添加 Cursor Key') + '</option>'];
    list.forEach(function(key){
      var label = (key.label || key.maskedKey || key.id) + (key.status === 'disabled' ? '（已禁用）' : '');
      opts.push('<option value="' + esc(key.id) + '">' + esc(label) + '</option>');
    });
    sel.innerHTML = opts.join('');
    if (current) sel.value = current;
    $('btn-cc-from-key').disabled = !list.length;
  }

  function renderConnectStatus(data){
    var status = data.status || {};
    var box = $('connect-status-box');
    box.className = 'callout' + (status.available ? '' : ' warn');
    $('connect-status-title').textContent = status.available ? 'Connect 路线可用' : 'Connect 路线未就绪';
    var bits = [];
    if (status.activeCredentials !== undefined) {
      bits.push(status.activeCredentials + ' / ' + (status.credentials || 0) + ' 把凭据可用');
    }
    if (status.reason) bits.push(status.reason);
    if (data.settings && data.settings.defaultProvider === 'connect') bits.push('已设为默认 provider');
    else bits.push('默认仍走 SDK 路线；本页「对话测试」或联通性测试里选 Connect，即可实际发请求');
    $('connect-status-detail').textContent = bits.join('；');
  }

  function renderConnectSettings(settings){
    var rows = CC_SETTING_ROWS.map(function(row){
      var value = settings[row[1]];
      if (Array.isArray(value)) value = value.length ? value.join(', ') : '（全关）';
      else if (typeof value === 'boolean') value = value ? '开' : '关';
      return '<tr><td>' + esc(row[0]) + '</td><td><code>' + esc(value === undefined ? '-' : value) +
        '</code></td><td class="muted">' + esc(row[2]) + '</td></tr>';
    });
    $('cc-settings-body').innerHTML = rows.join('');
  }

  function renderConnectCredentials(list){
    $('cc-empty').classList.toggle('hidden', list.length > 0);
    $('cc-body').innerHTML = list.map(function(item){
      var badge = item.status === 'active' ? '<span class="chip ok">● 可用</span>' : '<span class="chip bad">● 停用</span>';
      var warn = item.tokenType === 'web' ? ' <span class="chip bad">web token</span>' : '';
      if (item.sourceCursorKeyId) warn += ' <span class="chip">Key 池</span>';
      var actions = [
        '<button data-cc-test="' + esc(item.id) + '">测试</button>',
        item.status === 'active'
          ? '<button data-cc-disable="' + esc(item.id) + '">停用</button>'
          : '<button data-cc-enable="' + esc(item.id) + '">启用</button>',
        '<button data-cc-rotate="' + esc(item.id) + '">换 token</button>',
        '<button class="danger" data-cc-del="' + esc(item.id) + '">删除</button>'
      ].join(' ');
      return '<tr>' +
        '<td>' + esc(item.label || '-') + '</td>' +
        '<td><code>' + esc(item.tokenHint) + '</code></td>' +
        '<td>' + esc(item.tokenType) + warn + '</td>' +
        '<td><code>' + esc(item.machineId) + '</code>' + (item.hasMacMachineId ? ' +mac' : '') + '</td>' +
        '<td>' + esc(item.clientVersion) + '</td>' +
        '<td>' + badge + '</td>' +
        '<td>' + (item.failureCount || 0) + (item.lastError ? ' <span class="hint" title="' + esc(item.lastError) + '">?</span>' : '') + '</td>' +
        '<td class="muted">' + esc(item.lastUsedAt ? item.lastUsedAt.replace('T', ' ').slice(0, 19) : '-') + '</td>' +
        '<td class="row" style="gap:6px">' + actions + '</td>' +
        '</tr>';
    }).join('');
  }

  function loadConnectModels(force){
    $('cc-models-hint').textContent = '正在拉取…';
    api('GET', '/admin/api/connect/models' + (force ? '?refresh=true' : '')).then(function(data){
      var models = data.models || [];
      connectCatalog = models;
      $('cc-models-empty').classList.toggle('hidden', models.length > 0);
      $('cc-models-hint').textContent = models.length + ' 个模型' + (force ? '（已强制刷新）' : '');
      $('cc-models-body').innerHTML = models.map(function(model){
        var caps = [];
        if (model.supportsAgent) caps.push('agent');
        if (model.supportsThinking) caps.push('thinking');
        if (model.supportsImages) caps.push('images');
        if (model.supportsMaxMode) caps.push('max');
        var params = (model.parameters || []).map(function(p){
          return p.id + '(' + (p.values || []).map(function(v){ return v.value; }).join('/') + ')';
        });
        var state = model.degradation === 'degraded'
          ? '<span class="chip warn">● 降级</span>'
          : '<span class="chip ok">● 正常</span>';
        return '<tr>' +
          '<td><code>' + esc(model.id) + '</code>' + (model.defaultOn ? ' <span class="hint">默认</span>' : '') + '</td>' +
          '<td>' + esc(model.displayName || '-') + '</td>' +
          '<td>' + esc(model.contextTokenLimit || '-') + '</td>' +
          '<td class="muted">' + esc(caps.join(', ') || '-') + '</td>' +
          '<td class="muted">' + esc(params.join(' ') || '-') + '</td>' +
          '<td>' + state + '</td>' +
          '</tr>';
      }).join('');
      fillCcChatModels();
      if (testProvider() === 'connect') fillModelSelects();
    }).catch(function(err){
      $('cc-models-hint').textContent = '拉取失败：' + err.message;
      fillCcChatModels();
    });
  }

  function loadConnectRuns(){
    api('GET', '/admin/api/connect/runs?limit=50').then(function(data){
      var runs = data.runs || [];
      $('cc-runs-empty').classList.toggle('hidden', runs.length > 0);
      $('cc-runs-hint').textContent = runs.length + ' 条';
      $('cc-runs-body').innerHTML = runs.map(function(run){
        var terminal = run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled';
        var cls = run.status === 'completed' ? 'ok' : (run.status === 'failed' ? 'bad' : 'warn');
        return '<tr>' +
          '<td><code>' + esc(run.id.slice(0, 8)) + '</code></td>' +
          '<td>' + esc(run.requestedModel) + '</td>' +
          '<td><span class="chip ' + cls + '">● ' + esc(run.status) + '</span></td>' +
          '<td class="muted">' + esc(run.deliveryState) + '</td>' +
          '<td>' + esc(run.attempt) + '</td>' +
          '<td>' + esc(run.lastEventSeq) + '</td>' +
          '<td class="muted">' + esc(run.startedAt ? run.startedAt.replace('T', ' ').slice(0, 19) : '-') + '</td>' +
          '<td class="row" style="gap:6px">' +
            '<button data-cc-run="' + esc(run.id) + '">详情</button>' +
            (terminal ? '' : '<button class="danger" data-cc-run-cancel="' + esc(run.id) + '">取消</button>') +
          '</td>' +
          '</tr>';
      }).join('');
    }).catch(function(err){
      $('cc-runs-hint').textContent = '读取失败：' + err.message;
    });
  }
  function closeMenu(){
    $('sidebar').classList.remove('open');
    $('sidebar-mask').classList.add('hidden');
  }
  function openMenu(){
    $('sidebar').classList.add('open');
    $('sidebar-mask').classList.remove('hidden');
  }

  function strategyLabel(v){
    return v === 'round-robin' ? 'round-robin（加权轮询）' : 'fill-first（吃满第一把）';
  }
  function sysModeLabel(v){
    if (v === 'append') return 'append（追加）';
    if (v === 'override') return 'override（覆盖）';
    return 'off（不注入）';
  }
  // 三态开关的回显。HTML 的 checkbox 只有两个状态，用它承载三态的直接后果是：
  // 「没人表过态」会被当成「显式关闭」提交上去，配代理时的自动启用从此再也不会发生，
  // 而模型流量会在运维毫不知情的情况下绕过代理直连。所以这里必须认来源，而不只是布尔值。
  function http1ModeOf(cfg){
    if (cfg.cursorSdkUseHttp1Source !== 'stored') return 'auto';
    return cfg.cursorSdkUseHttp1ForAgent ? 'on' : 'off';
  }
  function http1Hint(cfg){
    var state = cfg.cursorSdkUseHttp1ForAgent ? '已开启' : '已关闭';
    var src = cfg.cursorSdkUseHttp1Source;
    if (src === 'stored') return '当前 ' + state + '（后台设置）';
    if (src === 'env') return '当前 ' + state + '（环境变量 CURSOR_SDK_USE_HTTP1_FOR_AGENT）';
    if (src === 'proxy') return '当前已开启（配了代理自动开）';
    return '当前 ' + state + '（默认）';
  }
  function applyHttp1Form(cfg){
    $('sdk-http1-mode').value = http1ModeOf(cfg);
    $('sdk-http1-hint').textContent = http1Hint(cfg);
  }
  // Fast / Max Mode 三态策略的表单状态。selected 保留当前勾选（含目录外手动添加项），
  // 目录晚到 / 轮询刷新时重渲染列表不会把勾选洗掉。
  var policySelected = { fast: [], 'max-mode': [] };
  // 与后端 model-params.ts 的 /fast/i、MAX_MODE_PARAM 同口径的参数维度匹配。
  function policyParamRegex(dim){
    return dim === 'fast' ? /fast/i : /max.?mode|context|window|long|token|length|^1m$/i;
  }
  // 勾选列表只列「目录显示支持该参数」的模型；允许手动加尚未出现在目录里的 id。
  function policyCandidateIds(dim){
    var re = policyParamRegex(dim);
    var ids = [];
    modelCatalog.forEach(function(m){
      if ((m.parameters || []).some(function(p){ return re.test(p.id); })) ids.push(m.id);
    });
    return ids;
  }
  function applyPolicyForm(dim, mode, models){
    policySelected[dim] = (models || []).slice();
    var select = $(dim + '-policy');
    select.value = mode === 'force-all' || mode === 'force-selected' ? mode : 'passthrough';
    togglePolicyModelsField(dim);
    renderPolicyModels(dim);
  }
  function togglePolicyModelsField(dim){
    $(dim + '-models-field').classList.toggle('hidden', $(dim + '-policy').value !== 'force-selected');
  }
  function renderPolicyModels(dim){
    var list = $(dim + '-models-list');
    if (!list) return;
    var selected = policySelected[dim] || [];
    var seen = {};
    var ids = [];
    policyCandidateIds(dim).forEach(function(id){ if (!seen[id]) { ids.push(id); seen[id] = true; } });
    selected.forEach(function(id){ if (id && !seen[id]) { ids.push(id); seen[id] = true; } });
    if (!ids.length) {
      list.innerHTML = '<div class="muted small">目录里暂无支持该参数的模型，可用下方输入框手动添加</div>';
      return;
    }
    var html = '';
    ids.forEach(function(id){
      html += '<label class="toggle"><input type="checkbox" data-policy="' + dim + '" value="' + esc(id) + '"'
        + (selected.indexOf(id) !== -1 ? ' checked' : '') + '> ' + esc(id) + '</label>';
    });
    list.innerHTML = html;
  }
  function addPolicyModel(dim){
    var input = $(dim + '-models-extra');
    var id = input.value.trim();
    if (!id) return;
    if (policySelected[dim].indexOf(id) === -1) policySelected[dim].push(id);
    input.value = '';
    renderPolicyModels(dim);
  }
  function collectPolicyModels(dim){
    var out = [];
    var boxes = $(dim + '-models-list').querySelectorAll('input[type="checkbox"]');
    for (var i = 0; i < boxes.length; i++) if (boxes[i].checked) out.push(boxes[i].value);
    return out;
  }
  // 重建列表前把 DOM 勾选现状写回 policySelected。只在列表已渲染（有 checkbox）时收集：
  // 列表还没建过（空目录占位）时 DOM 里没有用户可改的东西，回写空数组反而会清掉手动添加项。
  function syncPolicySelection(dim){
    if ($(dim + '-models-list').querySelector('input[type="checkbox"]')) {
      policySelected[dim] = collectPolicyModels(dim);
    }
  }

  function applySettingsForm(cfg, force){
    if (!cfg) return;
    var el = document.activeElement;
    if (!force && el && el.closest && el.closest('#sec-settings')) return;
    applyHttp1Form(cfg);
    http1ModeDirty = false;
    applyPolicyForm('fast', cfg.cursorFastPolicy, cfg.cursorFastModels);
    applyPolicyForm('max-mode', cfg.cursorMaxModePolicy, cfg.cursorMaxModeModels);
    autoDisableThreshold = cfg.autoDisableThreshold || 1;
    $('auto-disable-toggle').checked = !!cfg.autoDisableKeys;
    $('auto-disable-threshold').value = autoDisableThreshold;
    sandClientMode = !!cfg.sandClientMode;
    $('sand-mode-toggle').checked = sandClientMode;
    $('sand-hook-hint').textContent = sandClientMode && cfg.sandClientHookPatched === false
      ? '（SDK 尚未加载或注入未生效，重启后看启动日志）'
      : (cfg.sandClientHookPatched === true ? '（Sand hook 已生效）' : '');
    $('session-mode').value = cfg.cursorSdkSessionMode === 'stateless' ? 'stateless' : 'durable';
    $('tool-hold-ttl').value = cfg.cursorSdkToolHoldTtlMs || 900000;
    $('session-idle-ttl').value = cfg.cursorSdkSessionIdleTtlMs || 3600000;
    $('max-live-sessions').value = cfg.cursorSdkMaxLiveSessions || 256;
    $('allow-direct-toggle').checked = cfg.allowDirectCursorKeys !== false;
    $('builtin-tools-toggle').checked = !!cfg.cursorAllowBuiltinTools;
    $('request-timeout').value = cfg.requestTimeoutMs || 180000;
    $('request-log-keep').value = cfg.requestLogKeep == null ? 0 : cfg.requestLogKeep;
    $('max-key-attempts').value = cfg.maxKeyAttempts || 10;
    $('max-transient-attempts').value = cfg.maxTransientAttempts || 3;
    $('reasoning-effort').value = cfg.cursorReasoningEffort || '';
    $('agent-mode').value = cfg.cursorAgentMode || '';
    $('model-params').value = cfg.cursorModelParams || '';
    renderBootEnv(cfg);
  }
  function renderBootEnv(cfg){
    var rows = [
      ['监听地址', (cfg.host || '') + ':' + (cfg.port || ''), 'HOST / PORT'],
      ['工作目录', cfg.workingDirectory || '', 'CURSOR_WORKING_DIRECTORY'],
      ['状态库', cfg.sqlitePath || '', 'SQLITE_PATH'],
      ['SDK 客户端版本', cfg.sdkClientVersion || '', 'CURSOR_SDK_CLIENT_VERSION'],
      ['启动预热', cfg.cursorPrewarm === false ? '关' : '开', 'CURSOR_PREWARM']
    ];
    $('boot-env-body').innerHTML = rows.map(function(row){
      return '<tr><td>' + esc(row[0]) + '</td><td class="mono">' + esc(row[1]) + '</td><td class="mono muted">' + esc(row[2]) + '</td></tr>';
    }).join('');
  }
  function applyRoutingForm(cfg){
    if (!cfg) return;
    var el = document.activeElement;
    if (el && el.closest && el.closest('#sec-routing')) return;
    var radios = document.querySelectorAll('input[name="routing-strategy"]');
    for (var i = 0; i < radios.length; i++) radios[i].checked = radios[i].value === (cfg.routingStrategy || 'fill-first');
    $('affinity-toggle').checked = !!cfg.sessionAffinity;
    $('affinity-ttl').value = cfg.sessionAffinityTtlMs || 3600000;
  }
  function applySysForm(cfg){
    if (!cfg) return;
    var el = document.activeElement;
    if (el && el.closest && el.closest('#sec-system-prompt')) return;
    // 只同步模式。正文由 hydrateSystemPrompt 走专门的读接口负责，
    // 这里别碰它——overview 每 10 秒轮询一次，覆写会把用户刚载入或正在改的内容抹掉。
    $('sys-mode').value = cfg.systemPromptMode || 'off';
    if (!$('sys-text').value) {
      $('sys-set-hint').textContent = cfg.systemPromptSet ? '已保存正文，进入本页会自动载入' : '尚未设置正文';
    }
  }

  function renderOverview(data){
    lastOverview = data;
    var cfg = data.config || {};
    $('chip-version').textContent = 'v' + data.version;
    $('chip-uptime').textContent = '运行 ' + fmtUptime(data.uptimeSeconds);
    $('side-version').textContent = 'v' + data.version;
    $('side-uptime').textContent = '运行 ' + fmtUptime(data.uptimeSeconds);
    $('chip-direct').textContent = '直传 key：' + (cfg.allowDirectCursorKeys ? '允许' : '禁止');
    $('chip-session').textContent = '会话：' + (cfg.cursorSdkSessionMode === 'stateless' ? 'stateless' : 'durable');
    $('chip-http1').textContent = 'HTTP：' + (cfg.cursorSdkUseHttp1ForAgent ? '1.1' : '默认');
    $('chip-autodisable').textContent = '自动禁用：'
      + (cfg.autoDisableKeys ? '连续失败 ' + (cfg.autoDisableThreshold || 1) + ' 次' : '已关闭');
    sandClientMode = !!cfg.sandClientMode;
    $('chip-sand').textContent = '通道：' + (sandClientMode ? 'Sand' : 'SDK');
    applySettingsForm(cfg);
    applyRoutingForm(cfg);
    applySysForm(cfg);

    $('st-keys').textContent = data.keys.active + ' / ' + data.keys.total;
    $('st-keys-d').textContent = '已禁用 ' + data.keys.disabled + ' 个';
    gwPoolEnabled = !!data.gatewayKeys;
    $('card-gw').classList.toggle('hidden', !gwPoolEnabled);
    if (data.gatewayKeys) {
      $('st-gw').textContent = data.gatewayKeys.active + ' / ' + data.gatewayKeys.total;
      $('st-gw-d').textContent = '已禁用 ' + data.gatewayKeys.disabled + ' 个';
    }
    $('st-total').textContent = data.requests.total;
    var rate = data.requests.total ? Math.round(data.requests.success / data.requests.total * 100) : null;
    $('st-total-d').textContent = rate == null ? '暂无数据' : '成功率 ' + rate + '%（失败 ' + data.requests.errors + '）';
    $('st-24h').textContent = data.requests.last24h.total;
    $('st-24h-d').textContent = '其中失败 ' + data.requests.last24h.errors;
    $('st-avg').textContent = data.requests.avgDurationMs == null ? '—' : (data.requests.avgDurationMs / 1000).toFixed(1) + 's';

    var tokens = data.requests.tokens || {};
    $('st-tokens').textContent = fmtNum(tokens.total);
    $('st-tokens-d').textContent = '入 ' + fmtNum(tokens.input) + ' / 出 ' + fmtNum(tokens.output)
      + ' / 缓存读 ' + fmtNum(tokens.cacheRead) + ' / 缓存写 ' + fmtNum(tokens.cacheWrite);
    var estimatedTokens = data.requests.estimatedTokens || {};
    $('st-estimated-tokens').textContent = fmtNum(estimatedTokens.total);
    $('st-estimated-tokens-d').textContent = '入 ' + fmtNum(estimatedTokens.input) + ' / 出 ' + fmtNum(estimatedTokens.output)
      + ' / 缓存读 ' + fmtNum(estimatedTokens.cacheRead) + ' / 缓存写 ' + fmtNum(estimatedTokens.cacheWrite);
    var cost = data.requests.cost || {};
    $('st-cost').textContent = fmtUsdFromCents(cost.chargedCents);
    $('st-cost-d').textContent = '实付 ' + (cost.chargedCents == null ? '—' : Number(cost.chargedCents).toFixed(4) + '¢')
      + ' · 标价 ' + (cost.rawCostCents == null ? '—' : Number(cost.rawCostCents).toFixed(4) + '¢')
      + '（chargedCents÷100 = 美元，4 位小数）';

    var proxy = cfg.proxy || {};
    var html = '';
    html += cfgItem('会话模式', cfg.cursorSdkSessionMode === 'stateless' ? 'stateless' : 'durable');
    html += cfgItem('直传 Cursor key', cfg.allowDirectCursorKeys ? '允许' : '禁止');
    html += cfgItem('上游超时', (cfg.requestTimeoutMs || 0) + ' ms');
    html += cfgItem('取用策略', strategyLabel(cfg.routingStrategy));
    html += cfgItem('会话粘性', cfg.sessionAffinity
      ? '开 · TTL ' + (cfg.sessionAffinityTtlMs || 0) + ' ms'
      : '关');
    html += cfgItem('系统提示词', sysModeLabel(cfg.systemPromptMode) + (cfg.systemPromptSet ? ' · 已设置正文' : ' · 无正文'));
    html += cfgItem('代理', proxy.enabled
      ? ((proxy.scheme || '') + ' ' + (proxy.url || '') + (proxy.modelTrafficProxied ? ' · 模型流量已走代理' : ' · 模型流量仍直连'))
      : '未启用');
    html += cfgItem('通道', sandClientMode ? 'Sand' : 'SDK');
    html += cfgItem('自动禁用', cfg.autoDisableKeys ? '连续失败 ' + (cfg.autoDisableThreshold || 1) + ' 次' : '已关闭');
    $('cfg-summary').innerHTML = html;

    renderDurable(data.durable);
    renderGwAvailability();
  }
  function renderDurable(durable){
    durable = durable || {};
    var cache = durable.cache || {};
    var hit = cache.hitRatio == null ? '—' : ((Math.round(cache.hitRatio * 1000) / 10) + '%');
    var dhtml = '';
    dhtml += cfgItem('缓存命中率', hit);
    dhtml += cfgItem('缓存样本', String(cache.requests || 0));
    dhtml += cfgItem('活槽', String(durable.liveSessions || 0));
    var decisions = durable.decisions || {};
    var dkeys = Object.keys(decisions);
    dhtml += cfgItem('决策', dkeys.length ? dkeys.map(function(k){ return k + ' ' + decisions[k]; }).join(' · ') : '暂无');
    $('durable-summary').innerHTML = dhtml;
    var ident = durable.identitySource || {};
    $('durable-identity').textContent = '身份来源：header ' + (ident.header || 0)
      + ' · body-field ' + (ident['body-field'] || 0)
      + ' · derived-L3 ' + (ident['derived-L3'] || 0)
      + ' · none ' + (ident.none || 0);
    var recent = durable.recent || [];
    var rows = recent.slice().reverse().map(function(item){
      return '<tr><td class="mono">' + esc(fmtTime(item.at)) + '</td>'
        + '<td>' + esc(item.decision || '') + '</td>'
        + '<td class="muted">' + esc(item.reason || '—') + '</td>'
        + '<td class="mono">' + esc(item.session || '—') + '</td>'
        + '<td class="muted">' + esc(item.kind || '—') + '</td></tr>';
    }).join('');
    $('durable-recent').innerHTML = rows || '<tr><td colspan="5" class="empty">暂无决策</td></tr>';
  }
  function cfgItem(k, v){
    return '<div class="config-item"><div class="k">' + esc(k) + '</div><div class="v">' + esc(v) + '</div></div>';
  }

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
    var html = '<select data-action="channel" data-id="' + esc(key.id) + '" title="该 key 的 Cursor 通道" style="padding:4px 8px;font-size:12px">';
    [['inherit','跟随全局'],['sdk','强制 SDK'],['sand','强制 Sand']].forEach(function(item){
      html += '<option value="' + item[0] + '"' + (current === item[0] ? ' selected' : '') + '>' + item[1] + '</option>';
    });
    html += '</select>';
    var resolved = resolvedChannel(key);
    html += ' <span class="badge ' + resolved + '">' + (resolved === 'sand' ? 'Sand' : 'SDK') + '</span>';
    return html;
  }
  function scopeSummary(scope){
    var a = (scope && scope.allowed) || [];
    var e = (scope && scope.excluded) || [];
    if (!a.length && !e.length) return '<span class="muted scope-chip" title="白名单与黑名单都为空，不限制">全部</span>';
    var tip = [];
    if (a.length) tip.push('白名单：' + a.join(', '));
    if (e.length) tip.push('黑名单：' + e.join(', '));
    return '<span class="scope-chip" title="' + esc(tip.join(' | ')) + '">白 ' + a.length + ' / 黑 ' + e.length + '</span>';
  }
  function keyLabelById(id){
    for (var i = 0; i < lastKeys.length; i++) {
      if (lastKeys[i].id === id) return lastKeys[i].label || lastKeys[i].maskedKey || id;
    }
    return id;
  }
  function isDeadBinding(ids){
    return !!ids && ids.indexOf(NO_KEY_SENTINEL) !== -1;
  }
  function bindingLostSinceOpen(state){
    if (!state || state.dead) return false;
    var original = state.originalBindIds || [];
    if (!original.length) return false;
    var available = {};
    lastKeys.forEach(function(key){ available[key.id] = true; });
    for (var i = 0; i < original.length; i++) {
      if (original[i] !== NO_KEY_SENTINEL && !available[original[i]]) return true;
    }
    return false;
  }
  function bindSummary(ids){
    if (!ids || !ids.length) return '<span class="muted scope-chip" title="空列表表示不限制，可使用整个 Cursor Key 池">不限制</span>';
    if (isDeadBinding(ids)) {
      return '<span class="badge disabled scope-chip" title="这把网关密钥原本绑定的 Cursor key 已全部删除。为避免权限反向放大成整池可用，网关把它记成「什么都不能用」，'
        + '当前所有请求都会返回 403 not_authorized。点「编辑」重新绑定可用的 key。">已失效：绑定的 Cursor key 已删除</span>';
    }
    var names = ids.map(keyLabelById);
    return '<span class="scope-chip" title="' + esc(names.join(', ')) + '">' + ids.length + ' 把</span>';
  }

  function renderKeys(keys){
    lastKeys = keys || [];
    var focused = document.activeElement;
    if (focused && focused.closest && focused.closest('#keys-body')) return;
    var body = $('keys-body');
    $('keys-empty').classList.toggle('hidden', lastKeys.length > 0);
    if (!lastKeys.length) {
      body.innerHTML = '';
      fillLogKeyFilters();
      return;
    }
    var html = '';
    lastKeys.forEach(function(key, index){
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
        + '<button data-action="up" data-id="' + esc(key.id) + '" title="上移（提高优先级）"' + (index === 0 ? ' disabled' : '') + '>↑</button>'
        + '<button data-action="down" data-id="' + esc(key.id) + '" title="下移（降低优先级）"' + (index === lastKeys.length - 1 ? ' disabled' : '') + '>↓</button>'
        + '</div>';
      var actions = '<button data-action="test" data-id="' + esc(key.id) + '">测试</button>';
      actions += '<button data-action="models" data-id="' + esc(key.id) + '">模型范围</button>';
      actions += '<button data-action="connect-import" data-id="' + esc(key.id) + '" title="用这把 key 向 Cursor 兑换 Connect session token">拉取 Connect</button>';
      if (key.status === 'active') {
        actions += '<button data-action="disable" data-id="' + esc(key.id) + '">禁用</button>';
      } else {
        actions += '<button data-action="enable" data-id="' + esc(key.id) + '">启用</button>';
      }
      actions += '<button class="danger" data-action="delete" data-id="' + esc(key.id) + '">删除</button>';
      html += '<tr>'
        + '<td>' + order + '</td>'
        + '<td>' + esc(key.label) + '</td>'
        + '<td class="mono">' + esc(key.maskedKey) + '</td>'
        + '<td><span class="badge ' + esc(key.status) + '">' + (key.status === 'active' ? '可用' : '已禁用') + '</span></td>'
        + '<td>' + channelSelect(key) + '</td>'
        + '<td>' + scopeSummary(key.modelScope) + '</td>'
        + '<td><input class="weight-input" type="number" min="1" max="1000000" step="1" data-action="weight" data-id="' + esc(key.id) + '" value="' + esc(key.weight || 1) + '" title="仅 round-robin 生效"></td>'
        + '<td>' + fmtNum(key.requestCount) + '</td>'
        + '<td>' + fmtNum(key.failureCount) + '</td>'
        + '<td class="muted small">' + fmtTime(key.lastUsedAt) + '</td>'
        + '<td>' + (reason || '<span class="muted">—</span>') + '</td>'
        + '<td><div class="actions">' + actions + '</div></td>'
        + '</tr>';
    });
    body.innerHTML = html;
    fillLogKeyFilters();
  }

  function renderGwAvailability(){
    $('gw-unwired').classList.toggle('hidden', gwPoolEnabled);
    $('gw-wired').classList.toggle('hidden', !gwPoolEnabled);
  }
  function renderGatewayKeys(keys){
    lastGwKeys = keys || [];
    var focused = document.activeElement;
    if (focused && focused.closest && focused.closest('#gw-body')) return;
    renderGwAvailability();
    if (!gwPoolEnabled) return;
    var body = $('gw-body');
    $('gw-empty').classList.toggle('hidden', lastGwKeys.length > 0);
    if (!lastGwKeys.length) { body.innerHTML = ''; fillLogKeyFilters(); return; }
    var html = '';
    lastGwKeys.forEach(function(key){
      var fromEnv = key.source === 'env';
      var actions = '<button data-action="edit" data-id="' + esc(key.id) + '">编辑</button>';
      actions += '<button data-action="models" data-id="' + esc(key.id) + '">模型范围</button>';
      if (key.status === 'active') {
        actions += '<button data-action="disable" data-id="' + esc(key.id) + '">禁用</button>';
      } else {
        actions += '<button data-action="enable" data-id="' + esc(key.id) + '">启用</button>';
      }
      // env 播种的密钥删不掉：legacy 分支照样放行，重启还会再播种一次。后端会 409，
      // 前端就别摆一个注定失败的按钮，直接把有效出路写在提示里。
      if (fromEnv) {
        actions += '<button class="danger" disabled title="这把密钥来自环境变量 GATEWAY_API_KEY，删不掉：删了表里的行，环境变量仍会放行，重启还会重新播种。'
          + '请从环境变量移除 GATEWAY_API_KEY 后重启，或直接「禁用」（即刻生效）。">删除</button>';
      } else {
        actions += '<button class="danger" data-action="delete" data-id="' + esc(key.id) + '">删除</button>';
      }
      html += '<tr>'
        + '<td>' + esc(key.label) + '</td>'
        + '<td class="mono">' + esc(key.maskedKey) + '</td>'
        + '<td><span class="badge ' + esc(key.status) + '">' + (key.status === 'active' ? '可用' : '已禁用') + '</span></td>'
        + '<td>' + (fromEnv
          ? '<span class="badge inherit" title="由 GATEWAY_API_KEY 播种，只能停用不能删除">env</span>'
          : '<span class="badge sdk">后台</span>') + '</td>'
        + '<td>' + bindSummary(key.allowedCursorKeyIds) + '</td>'
        + '<td>' + scopeSummary(key.modelScope) + '</td>'
        + '<td>' + fmtNum(key.requestCount) + '</td>'
        + '<td class="muted small">' + fmtTime(key.lastUsedAt) + '</td>'
        + '<td><div class="actions">' + actions + '</div></td>'
        + '</tr>';
    });
    body.innerHTML = html;
    fillLogKeyFilters();
  }
  function renderGatewayUnavailable(){
    gwPoolEnabled = false;
    lastGwKeys = [];
    renderGwAvailability();
  }

  function fillLogKeyFilters(){
    var keySel = $('log-key');
    var gwSel = $('log-gw');
    var keyIds = lastKeys.map(function(k){ return k.id; });
    var gwIds = lastGwKeys.map(function(k){ return k.id; });
    var keyCur = keySel.value;
    var gwCur = gwSel.value;
    var kh = '<option value="">全部 Cursor Key</option>';
    lastKeys.forEach(function(k){
      kh += '<option value="' + esc(k.id) + '">' + esc(k.label || k.maskedKey) + '</option>';
    });
    keySel.innerHTML = kh;
    var gh = '<option value="">全部网关密钥</option>';
    lastGwKeys.forEach(function(k){
      gh += '<option value="' + esc(k.id) + '">' + esc(k.label || k.maskedKey) + '</option>';
    });
    gwSel.innerHTML = gh;
    if (keyCur) keySel.value = keyCur;
    if (gwCur) gwSel.value = gwCur;
  }

  function testKey(id, button){
    var original = button.textContent;
    button.disabled = true;
    button.textContent = '测试中…';
    api('POST', '/admin/api/test', {
      keyId: id,
      provider: 'sdk',
      model: testProvider() === 'connect' ? (modelIds()[0] || 'composer-2.5') : $('test-model').value,
      prompt: $('test-prompt').value
    })
      .then(function(data){
        if (data.ok) {
          toast('✔ key 可用（' + (data.durationMs / 1000).toFixed(1) + 's，' + (data.keyLabel || '-') + '）');
        } else {
          toast('✘ ' + (data.keyLabel || '-') + ' 失败：' + data.error, true);
        }
        loadAll();
      })
      .catch(function(err){
        if (err.message !== 'unauthorized') toast('测试失败：' + err.message, true);
      })
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
    }).catch(function(err){
      if (err.message !== 'unauthorized') toast('调整失败：' + err.message, true);
    });
  }

  function usageCell(log){
    if (log.usageSource !== 'sdk' && log.usageSource !== 'estimated') {
      return '<span class="badge missing">未记录</span>';
    }
    var badge = log.usageSource === 'sdk'
      ? '<span class="badge sdk">实测</span>'
      : '<span class="badge estimated">估算</span>';
    var u = log.usage || {};
    var compact = (u.inputTokens || 0) + '/' + (u.outputTokens || 0);
    var cache = (u.cacheReadTokens || 0) + (u.cacheWriteTokens || 0);
    if (cache) compact += ' (+' + cache + ')';
    var tip = 'input=' + (u.inputTokens || 0)
      + ' output=' + (u.outputTokens || 0)
      + ' cacheRead=' + (u.cacheReadTokens || 0)
      + ' cacheWrite=' + (u.cacheWriteTokens || 0)
      + ' total=' + (u.totalTokens || 0)
      + (u.reasoningTokens != null ? ' reasoning=' + u.reasoningTokens : '')
      + ' source=' + log.usageSource;
    return badge + ' <span title="' + esc(tip) + '">' + esc(compact) + '</span>';
  }
  function costCell(log){
    if (!log.cost) return '<span class="muted">—</span>';
    var c = log.cost;
    var tip = 'chargedCents=' + c.chargedCents + '¢ → ' + fmtUsdFromCents(c.chargedCents)
      + '；rawCostCents=' + c.rawCostCents + '¢';
    return '<span title="' + esc(tip) + '">' + esc(fmtUsdFromCents(c.chargedCents)) + '</span>';
  }
  function paramsTip(params){
    if (!params || !params.length) return '';
    return params.map(function(p){ return (p.id || '') + '=' + (p.value || ''); }).join('; ');
  }
  // 三个参数列要能一眼看出是「实际下发值」还是「只是客户端的请求意图」：
  // 意图那一栏后面缀个 ?，鼠标悬停给出完整说明，否则两者长得一模一样、没法拿来对账。
  function paramCell(log, field, rendered){
    if (rendered === '—') return rendered;
    var fields = log.effectiveParams || [];
    if (fields.indexOf(field) >= 0) {
      return '<span title="实际下发给上游的值">' + rendered + '</span>';
    }
    return '<span class="muted" title="客户端/网关的请求意图，未能从实际下发的 model.params 反解出生效值">'
      + rendered + '<sup>?</sup></span>';
  }
  function logExtra(log){
    var lines = [];
    var tip = paramsTip(log.modelParams);
    lines.push('model.params: ' + (tip || '—'));
    if (log.usage) {
      lines.push('tokens: in=' + (log.usage.inputTokens || 0)
        + ' out=' + (log.usage.outputTokens || 0)
        + ' cacheRead=' + (log.usage.cacheReadTokens || 0)
        + ' cacheWrite=' + (log.usage.cacheWriteTokens || 0)
        + ' total=' + (log.usage.totalTokens || 0)
        + (log.usage.reasoningTokens != null ? ' reasoning=' + log.usage.reasoningTokens : ''));
    }
    if (log.cost) {
      lines.push('cost: charged=' + log.cost.chargedCents + '¢ (' + fmtUsdFromCents(log.cost.chargedCents)
        + ') raw=' + log.cost.rawCostCents + '¢');
    }
    if (log.usageSource) lines.push('usageSource: ' + log.usageSource);
    lines.push('实测生效的参数列: ' + ((log.effectiveParams || []).join(', ') || '无（三列均为请求意图）'));
    return lines.join('\\n');
  }

  function renderLogs(page){
    var logs = (page && page.logs) || [];
    logTotal = page && page.total != null ? page.total : logs.length;
    logOffset = page && page.offset != null ? page.offset : logOffset;
    logLimit = page && page.limit != null ? page.limit : logLimit;
    var body = $('logs-body');
    $('logs-empty').textContent = '暂无请求记录';
    $('logs-empty').classList.toggle('hidden', logs.length > 0);
    var html = '';
    logs.forEach(function(log, i){
      var modelTip = paramsTip(log.modelParams);
      html += '<tr>'
        + '<td class="muted small" style="white-space:nowrap">' + fmtTime(log.ts) + '</td>'
        + '<td class="mono">' + esc(log.endpoint) + '</td>'
        + '<td class="mono" title="' + esc(modelTip) + '">' + esc(log.model || '—') + '</td>'
        + '<td><span class="badge ' + esc(log.authMode || '') + '">' + esc(log.authMode || '—') + '</span></td>'
        + '<td class="muted small">' + esc(log.keyLabel || '—') + '</td>'
        + '<td class="muted small">' + esc(log.gatewayKeyLabel || '—') + '</td>'
        + '<td><span class="badge ' + statusClass(log.status) + '">' + esc(log.status) + '</span></td>'
        + '<td class="muted">' + (log.durationMs == null ? '—' : (log.durationMs / 1000).toFixed(1) + 's') + '</td>'
        + '<td>' + boolMark(log.stream) + '</td>'
        + '<td class="muted small">' + paramCell(log, 'reasoningEffort', esc(log.reasoningEffort || '—')) + '</td>'
        + '<td>' + paramCell(log, 'fast', boolMark(log.fast)) + '</td>'
        + '<td>' + paramCell(log, 'maxMode', boolMark(log.maxMode)) + '</td>'
        + '<td>' + (log.clientType ? '<span class="badge ' + esc(log.clientType) + '">' + esc(log.clientType) + '</span>' : '<span class="muted">—</span>') + '</td>'
        + '<td>' + esc(log.agentMode || '—') + '</td>'
        + '<td>' + usageCell(log) + '</td>'
        + '<td>' + costCell(log) + '</td>'
        + '<td>' + (log.error ? '<div class="err-text">' + esc(log.error) + '</div>' : '<span class="muted">—</span>')
        + '<button data-action="expand" data-i="' + i + '" style="margin-top:4px;padding:2px 8px;font-size:11px">详情</button>'
        + '<div class="log-detail hidden" id="log-extra-' + i + '">' + esc(logExtra(log)) + '</div>'
        + '</td>'
        + '</tr>';
    });
    body.innerHTML = html;
    var from = logTotal === 0 ? 0 : logOffset + 1;
    var to = logOffset + logs.length;
    $('log-page').textContent = '第 ' + from + '–' + to + ' 条，共 ' + logTotal + ' 条';
    $('btn-log-prev').disabled = logOffset <= 0;
    $('btn-log-next').disabled = logOffset + logs.length >= logTotal;
    $('hist-hint').textContent = '服务端分页 · 第 ' + from + '–' + to + ' / ' + logTotal;
  }

  function sinceISO(){
    var v = $('log-since').value;
    if (v === '1h') return new Date(Date.now() - 3600000).toISOString();
    if (v === '24h') return new Date(Date.now() - 86400000).toISOString();
    if (v === '7d') return new Date(Date.now() - 7 * 86400000).toISOString();
    return '';
  }
  function logsQueryUrl(){
    var q = ['limit=' + logLimit, 'offset=' + logOffset];
    var keyId = $('log-key').value;
    var gwId = $('log-gw').value;
    var model = $('log-model').value;
    var outcome = $('log-outcome').value;
    var since = sinceISO();
    if (keyId) q.push('keyId=' + encodeURIComponent(keyId));
    if (gwId) q.push('gatewayKeyId=' + encodeURIComponent(gwId));
    if (model) q.push('model=' + encodeURIComponent(model));
    if (outcome) q.push('outcome=' + encodeURIComponent(outcome));
    if (since) q.push('since=' + encodeURIComponent(since));
    return '/admin/api/logs?' + q.join('&');
  }
  function loadLogs(){
    $('logs-empty').textContent = '加载中…';
    $('logs-empty').classList.remove('hidden');
    return api('GET', logsQueryUrl()).then(function(page){
      renderLogs(page);
    }).catch(function(err){
      if (err.message !== 'unauthorized') toast('加载历史失败：' + err.message, true);
      $('logs-empty').textContent = '加载失败';
    });
  }

  function renderProxy(status){
    lastProxy = status || {};
    var s = lastProxy;
    var html = '<div class="config-list">';
    html += cfgItem('启用', s.enabled ? '是' : '否');
    html += cfgItem('掩码地址', s.url || '—');
    html += cfgItem('协议', s.scheme || '—');
    html += cfgItem('已装载', s.applied ? '是' : '否');
    html += cfgItem('云端 REST 走代理', s.applied ? '是' : '否');
    html += cfgItem('模型流量走代理', s.modelTrafficProxied ? '是' : '否');
    html += '</div>';
    if (s.warnings && s.warnings.length) {
      html += '<div class="note">告警：' + s.warnings.map(function(w){ return esc(w); }).join('；') + '</div>';
    }
    if (s.enabled && !s.modelTrafficProxied) {
      html += '<div class="warn-loud"><strong>模型请求仍在直连。</strong>'
        + ' 配了代理时网关会自动打开 HTTP/1.1，这里没打开说明有人显式关掉了它'
        + '（「运行设置」里选了「强制关闭」，或环境变量 CURSOR_SDK_USE_HTTP1_FOR_AGENT 写了 false）。'
        + ' HTTP/2 没有代理支持，所以模型流量不会进代理。'
        + '<div class="row" style="margin-top:10px"><button type="button" class="primary" id="btn-enable-http1">立即启用 HTTP/1.1</button></div></div>';
    }
    $('proxy-status').innerHTML = html;
    var btn = $('btn-enable-http1');
    if (btn) {
      btn.addEventListener('click', function(){
        api('POST', '/admin/api/settings', { cursorSdkUseHttp1ForAgent: true }).then(function(){
          toast('已启用 HTTP/1.1');
          loadAll();
          loadProxy();
        }).catch(function(err){
          if (err.message !== 'unauthorized') toast(err.message, true);
        });
      });
    }
  }
  function loadProxy(){
    return api('GET', '/admin/api/proxy').then(renderProxy).catch(function(err){
      if (err.message !== 'unauthorized') toast('加载代理状态失败：' + err.message, true);
    });
  }
  function probeRow(label, probe){
    if (!probe) return '';
    var body = probe.ok
      ? '✔ 通（' + (probe.durationMs / 1000).toFixed(1) + 's，HTTP ' + (probe.status != null ? probe.status : '-') + '）'
      : '✘ 不通（' + (probe.durationMs / 1000).toFixed(1) + 's）' + (probe.error ? '：' + probe.error : '');
    return '<div class="config-item"><div class="k">' + esc(label) + '</div><div class="v">' + esc(body)
      + '<div class="muted small">' + esc(probe.target || '') + '</div></div></div>';
  }

  function updateSysCount(){
    $('sys-count').textContent = $('sys-text').value.length + ' / 32000';
  }
  // 纯读接口。别用「POST 一次设置再看回显」来取正文：那是拿写操作做读操作，
  // 每次进页面都会白写一遍库，还会顺带重新应用一次设置。
  function hydrateSystemPrompt(){
    var el = document.activeElement;
    if (el && el.closest && el.closest('#sec-system-prompt')) return;
    return api('GET', '/admin/api/system-prompt').then(function(data){
      $('sys-mode').value = data.mode || 'off';
      $('sys-text').value = data.text || '';
      $('sys-set-hint').textContent = (data.text || '').trim() ? '已载入已保存正文' : '尚未设置正文';
      updateSysCount();
    }).catch(function(err){
      if (err.message !== 'unauthorized') toast('载入提示词失败：' + err.message, true);
    });
  }

  var loadGen = 0;
  function loadAll(){
    var gen = ++loadGen;
    loading = true;
    Promise.all([
      api('GET', '/admin/api/overview'),
      api('GET', '/admin/api/models'),
      api('GET', '/admin/api/keys')
    ]).then(function(results){
      if (gen !== loadGen) return;
      renderOverview(results[0]);
      setModelCatalog(results[1]);
      renderKeys(results[2].keys);
      var extra = [];
      if (gwPoolEnabled) {
        extra.push(api('GET', '/admin/api/gateway-keys').then(function(d){
          if (gen !== loadGen) return;
          renderGatewayKeys(d.keys);
        }).catch(function(err){
          if (gen !== loadGen) return;
          if (err.message === 'unauthorized') throw err;
          renderGatewayUnavailable();
        }));
      } else {
        renderGatewayUnavailable();
      }
      if (currentSection === 'history') extra.push(loadLogs());
      if (currentSection === 'proxy') extra.push(loadProxy());
      return Promise.all(extra);
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

  function closeModal(){
    modalState = null;
    $('modal-mask').classList.add('hidden');
  }
  function collectChecks(attr, value){
    var out = [];
    var boxes = $('modal-body').querySelectorAll('input[type="checkbox"]');
    for (var i = 0; i < boxes.length; i++) {
      if (boxes[i].checked && boxes[i].getAttribute(attr) === value) out.push(boxes[i].value);
    }
    return out;
  }
  function addScopeCheckbox(listId, scope, id){
    if (!id) return;
    var list = $(listId);
    var exists = list.querySelector('input[value="' + CSS.escape(id) + '"]');
    if (exists) { exists.checked = true; return; }
    var label = document.createElement('label');
    label.className = 'toggle';
    label.innerHTML = '<input type="checkbox" data-scope="' + scope + '" value="' + esc(id) + '" checked> ' + esc(id);
    list.appendChild(label);
  }
  function openScopeModal(kind, id, scope){
    modalState = { kind: kind, id: id };
    $('modal-title').textContent = '编辑模型范围';
    var allowed = (scope && scope.allowed) || [];
    var excluded = (scope && scope.excluded) || [];
    var html = '<p class="note" style="margin-top:0;margin-bottom:12px">白名单非空时只允许这些模型；黑名单优先拒绝。两边都空表示不限制。目录来自 GET /admin/api/models（不过滤）。也可手动添加尚未出现在目录里的模型 id。</p>';
    html += '<div class="scope-grid">';
    html += '<div><div class="k">白名单</div><div class="scope-list" id="scope-allowed">';
    html += scopeChecks(allowed, 'al') + '</div>';
    html += '<div class="row" style="margin-top:8px"><input id="scope-al-extra" placeholder="目录外的模型 id" style="flex:1"><button type="button" id="scope-al-add">添加</button></div></div>';
    html += '<div><div class="k">黑名单</div><div class="scope-list" id="scope-excluded">';
    html += scopeChecks(excluded, 'ex') + '</div>';
    html += '<div class="row" style="margin-top:8px"><input id="scope-ex-extra" placeholder="目录外的模型 id" style="flex:1"><button type="button" id="scope-ex-add">添加</button></div></div>';
    html += '</div>';
    $('modal-body').innerHTML = html;
    $('modal-mask').classList.remove('hidden');
    $('scope-al-add').addEventListener('click', function(){
      addScopeCheckbox('scope-allowed', 'al', $('scope-al-extra').value.trim());
      $('scope-al-extra').value = '';
    });
    $('scope-ex-add').addEventListener('click', function(){
      addScopeCheckbox('scope-excluded', 'ex', $('scope-ex-extra').value.trim());
      $('scope-ex-extra').value = '';
    });
  }
  function scopeChecks(selected, prefix){
    var ids = [];
    var seen = {};
    modelCatalog.forEach(function(m){
      if (m.id && !seen[m.id]) { ids.push(m.id); seen[m.id] = true; }
    });
    selected.forEach(function(id){
      if (id && !seen[id]) { ids.push(id); seen[id] = true; }
    });
    if (!ids.length) return '<div class="muted small">模型目录为空，请用下方输入框手动添加</div>';
    var html = '';
    ids.forEach(function(id){
      html += '<label class="toggle"><input type="checkbox" data-scope="' + prefix + '" value="' + esc(id) + '"'
        + (selected.indexOf(id) !== -1 ? ' checked' : '') + '> ' + esc(id) + '</label>';
    });
    return html;
  }
  function openBindModal(key){
    var selected = (key.allowedCursorKeyIds || []).slice();
    var dead = isDeadBinding(selected);
    modalState = { kind: 'bind', id: key.id, label: key.label || '', dead: dead, originalBindIds: selected.slice() };
    $('modal-title').textContent = '编辑网关密钥';
    var html = '<div class="row" style="margin-bottom:12px"><label class="toggle" style="color:var(--text);width:100%">备注'
      + '<input id="edit-gw-label" value="' + esc(key.label || '') + '" style="flex:1;min-width:180px"></label></div>';
    // 绑定已失效时不能沿用「不勾选=不限制」那句话：一个空表单直接保存就会把「什么都不能用」
    // 放开成「整池可用」，比原来的限制还宽。这种情况下要放开必须显式勾下面那个开关。
    if (dead) {
      html += '<p class="note" style="margin-top:0;margin-bottom:10px;color:var(--yellow)">这把密钥原本绑定的 Cursor key 已全部被删除，'
        + '网关已把它记成<strong>什么都不能用</strong>（请求返回 403 not_authorized）。'
        + '请在下面重新勾选可用的 key；直接保存会<strong>保持全禁</strong>，不会变成不限制。</p>';
    } else {
      html += '<p class="note" style="margin-top:0;margin-bottom:10px">可用 Cursor Key：不勾选表示不限制，可使用整个池。勾选后只允许这些 key。</p>';
    }
    html += '<div class="bind-list">';
    if (!lastKeys.length) {
      html += '<div class="muted">暂无 Cursor key</div>';
    } else {
      lastKeys.forEach(function(k){
        html += '<label class="toggle"><input type="checkbox" data-bind="1" value="' + esc(k.id) + '"'
          + (selected.length && selected.indexOf(k.id) !== -1 ? ' checked' : '') + '> '
          + esc(k.label || k.maskedKey) + ' <span class="mono muted">' + esc(k.maskedKey) + '</span></label>';
      });
    }
    html += '</div>';
    if (dead) {
      html += '<label class="toggle" style="margin-top:10px;color:var(--text)"><input type="checkbox" id="bind-unrestricted"> '
        + '解除限制：一把都不勾，改为可使用整个 Cursor Key 池</label>';
    }
    $('modal-body').innerHTML = html;
    $('modal-mask').classList.remove('hidden');
  }
  function saveModal(){
    if (!modalState) return;
    if (modalState.kind === 'key-scope') {
      var scope = { allowed: collectChecks('data-scope', 'al'), excluded: collectChecks('data-scope', 'ex') };
      api('POST', '/admin/api/keys/' + modalState.id + '/models', scope).then(function(){
        toast('已更新模型范围');
        closeModal();
        loadAll();
      }).catch(function(err){
        if (err.message !== 'unauthorized') toast(err.message, true);
      });
      return;
    }
    if (modalState.kind === 'gw-scope') {
      var gscope = { allowed: collectChecks('data-scope', 'al'), excluded: collectChecks('data-scope', 'ex') };
      api('POST', '/admin/api/gateway-keys/' + modalState.id, { allowed: gscope.allowed, excluded: gscope.excluded }).then(function(){
        toast('已更新模型范围');
        closeModal();
        loadAll();
      }).catch(function(err){
        if (err.message !== 'unauthorized') toast(err.message, true);
      });
      return;
    }
    if (modalState.kind === 'bind') {
      var ids = collectChecks('data-bind', '1');
      var unlock = $('bind-unrestricted');
      var state = modalState;
      // 先取一份最新 key 列表：自动刷新可能还没跑到，旧快照看不出绑定的最后一把已被删。
      // GET 与 POST 之间仍可能有并发删除，最终的原子校验需要后端按原绑定版本兜底。
      api('GET', '/admin/api/keys').then(function(data){
        if (modalState !== state) return;
        if (data && Array.isArray(data.keys)) lastKeys = data.keys;
        var stale = bindingLostSinceOpen(state);
        // 已失效的绑定必须原样把哨兵送回去：这里若发空数组，后端读到的就是「不限制」，
        // 一次无意的保存就能把一把什么都用不了的密钥放开成整池可用。
        if (!ids.length && (state.dead || stale) && !(unlock && unlock.checked)) {
          ids = [NO_KEY_SENTINEL];
          if (stale && !state.dead) toast('绑定的 Cursor key 已被其他操作删除，已保持全禁；如需放开请重新打开后明确解除限制。', true);
        }
        return api('POST', '/admin/api/gateway-keys/' + state.id, {
          label: $('edit-gw-label').value,
          allowedCursorKeyIds: ids
        });
      }).then(function(result){
        if (!result || modalState !== state) return;
        toast('已更新绑定');
        closeModal();
        loadAll();
      }).catch(function(err){
        if (err.message !== 'unauthorized') toast(err.message, true);
      });
    }
  }

  function findKey(id){
    for (var i = 0; i < lastKeys.length; i++) if (lastKeys[i].id === id) return lastKeys[i];
    return null;
  }
  function findGw(id){
    for (var i = 0; i < lastGwKeys.length; i++) if (lastGwKeys[i].id === id) return lastGwKeys[i];
    return null;
  }
  function copyText(text){
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function(){ toast('已复制'); }).catch(function(){ toast('复制失败', true); });
    } else {
      toast('复制失败', true);
    }
  }
  function showGwReveal(apiKey){
    revealedGwKey = apiKey || '';
    $('gw-reveal-key').textContent = revealedGwKey;
    $('gw-reveal').classList.toggle('hidden', !revealedGwKey);
  }

  $('login-btn').addEventListener('click', login);
  $('login-pass').addEventListener('keydown', function(event){ if (event.key === 'Enter') login(); });
  $('btn-refresh').addEventListener('click', loadAll);
  $('btn-logout').addEventListener('click', function(){
    localStorage.removeItem(TOKEN_KEY);
    token = '';
    showLogin('');
  });
  $('btn-menu').addEventListener('click', function(){
    if ($('sidebar').classList.contains('open')) closeMenu(); else openMenu();
  });
  $('sidebar-mask').addEventListener('click', closeMenu);
  $('nav').addEventListener('click', function(event){
    var btn = event.target.closest('[data-nav]');
    if (!btn) return;
    showSection(btn.getAttribute('data-nav'));
  });
  window.addEventListener('hashchange', function(){
    var name = (location.hash || '').replace(/^#\\/?/, '');
    if (SECTIONS[name] && name !== currentSection) showSection(name, false);
  });
  $('modal-close').addEventListener('click', closeModal);
  $('modal-cancel').addEventListener('click', closeModal);
  $('modal-save').addEventListener('click', saveModal);
  $('modal-mask').addEventListener('click', function(event){
    if (event.target === $('modal-mask')) closeModal();
  });

  $('btn-cc-add').addEventListener('click', function(){
    var token = $('cc-token').value.trim();
    if (!token) { toast('请先粘贴 session token', true); return; }
    var body = { sessionToken: token };
    var label = $('cc-label').value.trim();
    var machine = $('cc-machine').value.trim();
    if (label) body.label = label;
    if (machine) body.machineId = machine;
    api('POST', '/admin/api/connect/credentials', body).then(function(){
      // 明文 token 不留在输入框里：这个页面可能在共享屏幕上开着。
      $('cc-token').value = '';
      $('cc-label').value = '';
      $('cc-machine').value = '';
      toast('已添加 Connect 凭据');
      loadConnect();
    }).catch(function(err){
      if (err.message !== 'unauthorized') toast('添加失败：' + err.message, true);
    });
  });

  $('btn-cc-from-key').addEventListener('click', function(){
    var id = $('cc-from-key').value.trim();
    if (!id) { toast('请先选择一把 Cursor Key', true); return; }
    var body = { cursorKeyId: id };
    var label = $('cc-label').value.trim();
    var machine = $('cc-machine').value.trim();
    if (label) body.label = label;
    if (machine) body.machineId = machine;
    var btn = $('btn-cc-from-key');
    btn.disabled = true;
    var prev = btn.textContent;
    btn.textContent = '拉取中…';
    api('POST', '/admin/api/connect/credentials/from-key', body).then(function(){
      toast('已从 Key 拉取 Connect 凭据');
      loadConnect();
    }).catch(function(err){
      if (err.message !== 'unauthorized') toast('拉取失败：' + err.message, true);
    }).finally(function(){
      btn.disabled = false;
      btn.textContent = prev || '从 Key 拉取';
    });
  });

  $('btn-cc-models').addEventListener('click', function(){ loadConnectModels(false); });
  $('btn-cc-models-refresh').addEventListener('click', function(){ loadConnectModels(true); });
  $('btn-cc-runs').addEventListener('click', loadConnectRuns);
  $('btn-cc-chat').addEventListener('click', function(){
    runAdminChatTest({
      button: $('btn-cc-chat'),
      result: $('cc-chat-result'),
      provider: 'connect',
      model: $('cc-test-model').value,
      prompt: $('cc-test-prompt').value
    });
  });

  $('cc-body').addEventListener('click', function(event){
    var target = event.target;
    if (!target || target.tagName !== 'BUTTON') return;
    var id = target.getAttribute('data-cc-test');
    if (id) {
      target.disabled = true;
      target.textContent = '测试中…';
      api('POST', '/admin/api/connect/credentials/' + encodeURIComponent(id) + '/test').then(function(res){
        if (res.ok) toast('连通，目录 ' + res.models + ' 个模型（' + res.durationMs + 'ms）');
        else toast('测试失败 ' + (res.status || '') + '：' + (res.error || '未知错误'), true);
        loadConnect();
      }).catch(function(err){
        if (err.message !== 'unauthorized') toast('测试失败：' + err.message, true);
        loadConnect();
      });
      return;
    }
    id = target.getAttribute('data-cc-enable') || target.getAttribute('data-cc-disable');
    if (id) {
      var action = target.hasAttribute('data-cc-enable') ? 'enable' : 'disable';
      api('POST', '/admin/api/connect/credentials/' + encodeURIComponent(id) + '/' + action).then(function(){
        toast(action === 'enable' ? '已启用' : '已停用');
        loadConnect();
      }).catch(function(err){
        if (err.message !== 'unauthorized') toast('操作失败：' + err.message, true);
      });
      return;
    }
    id = target.getAttribute('data-cc-rotate');
    if (id) {
      var next = window.prompt('粘贴新的 session token（machineId 保持不变）');
      if (!next || !next.trim()) return;
      api('POST', '/admin/api/connect/credentials/' + encodeURIComponent(id), { sessionToken: next.trim() }).then(function(){
        toast('已更新 token');
        loadConnect();
      }).catch(function(err){
        if (err.message !== 'unauthorized') toast('更新失败：' + err.message, true);
      });
      return;
    }
    id = target.getAttribute('data-cc-del');
    if (id) {
      if (!window.confirm('删除这份凭据？之后走 Connect 的请求会改用其它凭据，没有其它凭据时会回落 SDK 路线。')) return;
      api('DELETE', '/admin/api/connect/credentials/' + encodeURIComponent(id)).then(function(){
        toast('已删除');
        loadConnect();
      }).catch(function(err){
        if (err.message !== 'unauthorized') toast('删除失败：' + err.message, true);
      });
    }
  });

  $('cc-runs-body').addEventListener('click', function(event){
    var target = event.target;
    if (!target || target.tagName !== 'BUTTON') return;
    var id = target.getAttribute('data-cc-run');
    if (id) {
      api('GET', '/admin/api/connect/runs/' + encodeURIComponent(id)).then(function(data){
        var box = $('cc-run-detail');
        box.classList.remove('hidden');
        box.textContent = JSON.stringify(data, null, 2);
      }).catch(function(err){
        if (err.message !== 'unauthorized') toast('读取失败：' + err.message, true);
      });
      return;
    }
    id = target.getAttribute('data-cc-run-cancel');
    if (id) {
      if (!window.confirm('取消这个 run？已经交付给客户端的内容不会撤回。')) return;
      api('POST', '/admin/api/connect/runs/' + encodeURIComponent(id) + '/cancel').then(function(){
        toast('已取消');
        loadConnectRuns();
      }).catch(function(err){
        if (err.message !== 'unauthorized') toast('取消失败：' + err.message, true);
      });
    }
  });

  $('btn-add-key').addEventListener('click', function(){
    var key = $('new-key').value.trim();
    var label = $('new-label').value.trim();
    if (!key) { toast('请先粘贴 Cursor API Key', true); return; }
    var weight = parseInt($('new-weight').value, 10);
    if (!(weight >= 1 && weight <= 1000000)) { toast('权重需为 1–1000000 的整数', true); return; }
    var allowed = parseCsv($('new-allowed').value);
    var excluded = parseCsv($('new-excluded').value);
    var body = {
      key: key,
      label: label || undefined,
      clientType: $('new-channel').value || 'inherit',
      weight: weight
    };
    if (allowed.length) body.allowed = allowed;
    if (excluded.length) body.excluded = excluded;
    api('POST', '/admin/api/keys', body).then(function(){
      $('new-key').value = '';
      $('new-label').value = '';
      $('new-channel').value = 'inherit';
      $('new-weight').value = '1';
      $('new-allowed').value = '';
      $('new-excluded').value = '';
      toast('已添加 key');
      loadAll();
    }).catch(function(err){
      if (err.message !== 'unauthorized') toast('添加失败：' + err.message, true);
    });
  });

  $('mint-show').addEventListener('change', function(){
    $('mint-token').style.webkitTextSecurity = $('mint-show').checked ? 'none' : 'disc';
  });
  $('btn-mint').addEventListener('click', function(){
    var sessionToken = $('mint-token').value.trim();
    if (!sessionToken) { toast('请粘贴 WorkosCursorSessionToken', true); return; }
    var name = $('mint-name').value.trim();
    var body = { sessionToken: sessionToken };
    if (name) body.name = name;
    $('mint-token').value = '';
    api('POST', '/admin/api/keys/mint', body).then(function(data){
      toast('已铸造：' + (data.name || (data.key && data.key.label) || '新 key'));
      loadAll();
    }).catch(function(err){
      if (err.message !== 'unauthorized') toast('铸造失败：' + err.message, true);
    });
  });

  $('btn-add-gw').addEventListener('click', function(){
    var payload = { label: $('new-gw-label').value.trim() || undefined };
    var pasted = $('new-gw-key').value.trim();
    if (pasted) payload.key = pasted;
    $('new-gw-key').value = '';
    api('POST', '/admin/api/gateway-keys', payload).then(function(data){
      $('new-gw-label').value = '';
      toast('已创建网关密钥');
      if (data.key && data.key.apiKey) showGwReveal(data.key.apiKey);
      loadAll();
    }).catch(function(err){
      if (err.message !== 'unauthorized') toast('创建失败：' + err.message, true);
    });
  });
  $('btn-copy-gw').addEventListener('click', function(){ if (revealedGwKey) copyText(revealedGwKey); });
  $('btn-hide-gw').addEventListener('click', function(){ showGwReveal(''); revealedGwKey = ''; });

  $('btn-save-routing').addEventListener('click', function(){
    var strategy = 'fill-first';
    var radios = document.querySelectorAll('input[name="routing-strategy"]');
    for (var i = 0; i < radios.length; i++) if (radios[i].checked) strategy = radios[i].value;
    var ttl = parseInt($('affinity-ttl').value, 10);
    if (!(ttl >= 1000)) { toast('会话粘性 TTL 至少 1000 ms', true); return; }
    api('POST', '/admin/api/settings', {
      routingStrategy: strategy,
      sessionAffinity: $('affinity-toggle').checked,
      sessionAffinityTtlMs: ttl
    }).then(function(){
      toast('策略已保存');
      loadAll();
    }).catch(function(err){
      if (err.message !== 'unauthorized') toast('保存失败：' + err.message, true);
    });
  });

  $('sys-text').addEventListener('input', updateSysCount);
  $('btn-save-sys').addEventListener('click', function(){
    api('POST', '/admin/api/settings', {
      systemPromptMode: $('sys-mode').value,
      systemPromptText: $('sys-text').value
    }).then(function(data){
      toast('提示词已保存');
      if (data.config) {
        $('sys-text').value = data.config.systemPrompt || '';
        $('sys-mode').value = data.config.systemPromptMode || $('sys-mode').value;
        updateSysCount();
      }
      loadAll();
    }).catch(function(err){
      if (err.message !== 'unauthorized') toast('保存失败：' + err.message, true);
    });
  });
  $('btn-load-sys').addEventListener('click', hydrateSystemPrompt);

  $('btn-save-proxy').addEventListener('click', function(){
    api('POST', '/admin/api/settings', { proxyUrl: $('proxy-url').value.trim() }).then(function(data){
      toast($('proxy-url').value.trim() ? '代理已保存' : '已关闭代理');
      // 网关替运维打开了 HTTP/1.1 时必须说出来，连同「什么时候才真的生效」一起，
      // 否则运维会以为点完保存模型流量就立刻进代理了。
      if (data && data.notice) toast(data.notice);
      if (data && data.executorResetWarning) toast(data.executorResetWarning, true);
      $('proxy-url').value = '';
      loadAll();
      loadProxy();
    }).catch(function(err){
      if (err.message !== 'unauthorized') toast('保存失败：' + err.message, true);
    });
  });
  $('sdk-http1-mode').addEventListener('change', function(){
    http1ModeDirty = true;
  });
  $('fast-policy').addEventListener('change', function(){ togglePolicyModelsField('fast'); });
  $('max-mode-policy').addEventListener('change', function(){ togglePolicyModelsField('max-mode'); });
  $('fast-models-add').addEventListener('click', function(){ addPolicyModel('fast'); });
  $('max-mode-models-add').addEventListener('click', function(){ addPolicyModel('max-mode'); });
  $('btn-test-proxy').addEventListener('click', function(){
    var url = $('proxy-url').value.trim();
    var result = $('proxy-test-result');
    result.classList.remove('hidden');
    result.textContent = '探测中…';
    api('POST', '/admin/api/proxy/test', url ? { proxyUrl: url } : {}).then(function(data){
      // 两条链路分开显示：它们是两套完全不同的客户端、两个不同的 host，
      // 只报一个「通」会让人拿 REST 的绿灯去推断对话能用，而这两件事没有因果关系。
      var html = '<div class="config-list">';
      html += probeRow('云端 REST（模型列表 / 用量 / 铸钥）', data.rest);
      html += probeRow('模型流量（对话请求真正走的 host）', data.model);
      html += '</div>';
      if (data.model && !data.model.ok) {
        html += '<div class="warn-loud"><strong>模型这条不通，对话请求会超时。</strong>'
          + ' REST 通只说明代理本身活着，不代表模型可用。</div>';
      } else if (data.model && data.model.ok && lastProxy && lastProxy.enabled && !lastProxy.modelTrafficProxied) {
        html += '<div class="warn-loud"><strong>隧道能通到模型 host，但当前模型流量并没有走它。</strong>'
          + ' HTTP/1.1 被关掉了，实际请求仍是不支持代理的 HTTP/2。</div>';
      }
      result.innerHTML = html;
    }).catch(function(err){
      result.textContent = '✘ ' + err.message;
    });
  });

  $('btn-save-settings').addEventListener('click', function(){
    var threshold = parseInt($('auto-disable-threshold').value, 10);
    if (!(threshold >= 1 && threshold <= 50)) { toast('连续失败次数需为 1-50 的整数', true); return; }
    var timeout = parseInt($('request-timeout').value, 10);
    if (!(timeout >= 5000)) { toast('上游超时至少 5000 ms', true); return; }
    var keep = parseInt($('request-log-keep').value, 10);
    if (!(keep >= 0)) { toast('请求历史保留条数需为 ≥0 的整数', true); return; }
    var hold = parseInt($('tool-hold-ttl').value, 10);
    if (!(hold >= 1000)) { toast('工具挂起等待至少 1000 ms', true); return; }
    var idle = parseInt($('session-idle-ttl').value, 10);
    if (!(idle >= 10000)) { toast('空闲回收至少 10000 ms', true); return; }
    var maxLive = parseInt($('max-live-sessions').value, 10);
    if (!(maxLive >= 1 && maxLive <= 10000)) { toast('存活会话上限需为 1–10000', true); return; }
    var maxAttempts = parseInt($('max-key-attempts').value, 10);
    if (!(maxAttempts >= 1 && maxAttempts <= 100)) { toast('轮换次数需为 1–100', true); return; }
    var transient = parseInt($('max-transient-attempts').value, 10);
    if (!(transient >= 1 && transient <= 50)) { toast('软失败重试需为 1–50', true); return; }
    var http1Mode = $('sdk-http1-mode').value;
    var body = {
      cursorFastPolicy: $('fast-policy').value,
      cursorFastModels: collectPolicyModels('fast'),
      cursorMaxModePolicy: $('max-mode-policy').value,
      cursorMaxModeModels: collectPolicyModels('max-mode'),
      autoDisableKeys: $('auto-disable-toggle').checked,
      autoDisableThreshold: threshold,
      sandClientMode: $('sand-mode-toggle').checked,
      cursorSdkSessionMode: $('session-mode').value,
      cursorSdkToolHoldTtlMs: hold,
      cursorSdkSessionIdleTtlMs: idle,
      cursorSdkMaxLiveSessions: maxLive,
      allowDirectCursorKeys: $('allow-direct-toggle').checked,
      cursorAllowBuiltinTools: $('builtin-tools-toggle').checked,
      requestTimeoutMs: timeout,
      requestLogKeep: keep,
      maxKeyAttempts: maxAttempts,
      maxTransientAttempts: transient,
      cursorReasoningEffort: $('reasoning-effort').value,
      cursorAgentMode: $('agent-mode').value,
      cursorModelParams: $('model-params').value
    };
    // 只有真的操作过这个控件才提交 null/布尔值；未触碰时省略字段，
    // 否则旧页面把「未设置」送给后端会清掉另一位管理员刚保存的显式选择。
    if (http1ModeDirty) body.cursorSdkUseHttp1ForAgent = http1Mode === 'auto' ? null : http1Mode === 'on';
    var button = $('btn-save-settings');
    button.disabled = true;
    button.textContent = '保存中…';
    api('POST', '/admin/api/settings', body).then(function(data){
      toast('设置已保存');
      http1ModeDirty = false;
      // 执行器没释放掉＝旧连接还在用旧协议，运维必须知道要重启，不能只有「已保存」。
      if (data && data.executorResetWarning) toast(data.executorResetWarning, true);
      if (data.config) {
        applyHttp1Form(data.config);
        applySettingsForm(data.config, true);
      }
      loadAll();
    }).catch(function(err){
      if (err.message !== 'unauthorized') toast('保存设置失败：' + err.message, true);
      loadAll();
    }).finally(function(){
      button.disabled = false;
      button.textContent = '保存设置';
    });
  });

  $('keys-body').addEventListener('change', function(event){
    var select = event.target.closest('select[data-action="channel"]');
    if (select) {
      var id = select.getAttribute('data-id');
      var clientType = select.value;
      select.disabled = true;
      api('POST', '/admin/api/keys/' + id + '/channel', { clientType: clientType }).then(function(){
        toast('已切换为' + channelLabel(clientType));
        loadAll();
      }).catch(function(err){
        if (err.message !== 'unauthorized') toast('切换通道失败：' + err.message, true);
        loadAll();
      }).finally(function(){ select.disabled = false; });
      return;
    }
    var weight = event.target.closest('input[data-action="weight"]');
    if (weight) {
      var n = parseInt(weight.value, 10);
      if (!(n >= 1 && n <= 1000000)) { toast('权重需为 1–1000000 的整数', true); return; }
      weight.disabled = true;
      api('POST', '/admin/api/keys/' + weight.getAttribute('data-id') + '/weight', { weight: n }).then(function(){
        toast('已更新权重');
      }).catch(function(err){
        if (err.message !== 'unauthorized') toast(err.message, true);
        loadAll();
      }).finally(function(){ weight.disabled = false; });
    }
  });

  $('keys-body').addEventListener('click', function(event){
    var button = event.target.closest('button[data-action]');
    if (!button) return;
    var id = button.getAttribute('data-id');
    var action = button.getAttribute('data-action');
    if (action === 'up' || action === 'down') { moveKey(id, action === 'up' ? -1 : 1); return; }
    if (action === 'test') { testKey(id, button); return; }
    if (action === 'models') {
      var key = findKey(id);
      modalState = { kind: 'key-scope', id: id };
      openScopeModal('key-scope', id, key && key.modelScope);
      return;
    }
    if (action === 'connect-import') {
      button.disabled = true;
      api('POST', '/admin/api/connect/credentials/from-key', { cursorKeyId: id }).then(function(){
        toast('已拉取 Connect 凭据，可到「Connect 凭据」页查看');
      }).catch(function(err){
        if (err.message !== 'unauthorized') toast('拉取失败：' + err.message, true);
      }).finally(function(){ button.disabled = false; });
      return;
    }
    if (action === 'delete') {
      if (!confirm('确定删除该 key？')) return;
      api('DELETE', '/admin/api/keys/' + id).then(function(){ toast('已删除'); loadAll(); })
        .catch(function(err){ if (err.message !== 'unauthorized') toast(err.message, true); });
      return;
    }
    api('POST', '/admin/api/keys/' + id + '/' + action).then(function(){
      toast(action === 'enable' ? '已启用' : '已禁用');
      loadAll();
    }).catch(function(err){ if (err.message !== 'unauthorized') toast(err.message, true); });
  });

  $('gw-body').addEventListener('click', function(event){
    var button = event.target.closest('button[data-action]');
    if (!button) return;
    var id = button.getAttribute('data-id');
    var action = button.getAttribute('data-action');
    var gw = findGw(id);
    if (action === 'edit') { if (gw) openBindModal(gw); return; }
    if (action === 'models') {
      modalState = { kind: 'gw-scope', id: id };
      openScopeModal('gw-scope', id, gw && gw.modelScope);
      return;
    }
    if (action === 'delete') {
      if (!confirm('确定删除该网关密钥？删除后无法找回明文。')) return;
      api('DELETE', '/admin/api/gateway-keys/' + id).then(function(){ toast('已删除'); loadAll(); })
        .catch(function(err){ if (err.message !== 'unauthorized') toast(err.message, true); });
      return;
    }
    api('POST', '/admin/api/gateway-keys/' + id + '/' + action).then(function(){
      toast(action === 'enable' ? '已启用' : '已禁用');
      loadAll();
    }).catch(function(err){ if (err.message !== 'unauthorized') toast(err.message, true); });
  });

  $('logs-body').addEventListener('click', function(event){
    var button = event.target.closest('button[data-action="expand"]');
    if (!button) return;
    var box = $('log-extra-' + button.getAttribute('data-i'));
    if (box) box.classList.toggle('hidden');
  });
  $('btn-log-apply').addEventListener('click', function(){
    logOffset = 0;
    logLimit = parseInt($('log-limit').value, 10) || 100;
    loadLogs();
  });
  $('btn-log-clear').addEventListener('click', function(){
    $('log-key').value = '';
    $('log-gw').value = '';
    $('log-model').value = '';
    $('log-outcome').value = '';
    $('log-since').value = '';
    logOffset = 0;
    loadLogs();
  });
  $('log-limit').addEventListener('change', function(){
    logLimit = parseInt($('log-limit').value, 10) || 100;
    logOffset = 0;
    loadLogs();
  });
  $('btn-log-prev').addEventListener('click', function(){
    logOffset = Math.max(0, logOffset - logLimit);
    loadLogs();
  });
  $('btn-log-next').addEventListener('click', function(){
    if (logOffset + logLimit < logTotal) {
      logOffset += logLimit;
      loadLogs();
    }
  });
  $('btn-clear-logs').addEventListener('click', function(){
    if (!confirm('确定清空全部请求历史？此操作不可恢复。')) return;
    api('POST', '/admin/api/logs/clear').then(function(data){
      toast('已清空 ' + (data.removed != null ? data.removed : '') + ' 条');
      logOffset = 0;
      loadLogs();
      loadAll();
    }).catch(function(err){
      if (err.message !== 'unauthorized') toast(err.message, true);
    });
  });

  function runAdminChatTest(opts){
    var button = opts.button;
    var result = opts.result;
    var original = button.textContent;
    button.disabled = true;
    button.textContent = '测试中…';
    result.classList.remove('hidden');
    result.textContent = '请求中，请稍候（首次冷启动可能需 20s+）…';
    api('POST', '/admin/api/test', {
      provider: opts.provider,
      model: opts.model,
      prompt: opts.prompt
    }).then(function(data){
      var route = data.provider === 'connect' ? 'Connect' : 'SDK';
      if (data.ok) {
        result.textContent = '✔ ' + route + ' 成功（' + (data.durationMs / 1000).toFixed(1) + 's'
          + (data.keyLabel ? '，key：' + data.keyLabel : '') + '）\\n' + data.text;
      } else {
        result.textContent = '✘ ' + route + ' 失败（' + (data.durationMs / 1000).toFixed(1) + 's'
          + (data.keyLabel ? '，key：' + data.keyLabel : '') + '）\\n' + data.error;
      }
      loadAll();
      if (currentSection === 'connect') loadConnect();
    }).catch(function(err){
      result.textContent = '✘ 请求失败：' + err.message;
    }).finally(function(){
      button.disabled = false;
      button.textContent = original;
    });
  }

  $('test-provider').addEventListener('change', function(){
    updateTestRouteHint();
    if (testProvider() === 'connect' && !connectCatalog.length) loadConnectModels(false);
    fillModelSelects();
  });

  $('btn-test').addEventListener('click', function(){
    runAdminChatTest({
      button: $('btn-test'),
      result: $('test-result'),
      provider: testProvider(),
      model: $('test-model').value,
      prompt: $('test-prompt').value
    });
  });

  fillCcChatModels();
  updateTestRouteHint();

  if (token) {
    api('POST', '/admin/api/login').then(function(){
      showApp();
      applyInitialSection();
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
