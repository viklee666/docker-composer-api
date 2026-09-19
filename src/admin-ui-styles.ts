/**
 * Offline admin console stylesheet. Replace the old inline CSS with ADMIN_STYLES.
 * Keep state in HTML/JS: .hidden, [hidden], .active, .open, .complete and .current.
 * No external fonts, images, framework, gradients or decorative shadows.
 */
export const ADMIN_STYLES = String.raw`
:root {
  color-scheme: light;
  --bg: #f6f6f3;
  --panel: #ffffff;
  --panel-2: #f8f8f6;
  --border: #e2e3e0;
  --border-strong: #c6c9ce;
  --text: #30343b;
  --muted: #686d76;
  --accent: #5963a6;
  --accent-hover: #47518e;
  --accent-soft: #eff0f8;
  --accent-2: #4d7274;
  --green: #347052;
  --green-soft: #edf5ef;
  --red: #ae4146;
  --red-soft: #fbefef;
  --yellow: #876420;
  --yellow-soft: #faf4e8;
  --radius: 8px;
  --radius-lg: 12px;
  --sidebar: 232px;
  --content-max: 1320px;
  --page-gutter: 32px;
  --mono: ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", Menlo, monospace;
  /* Preserve variables also referenced by legacy inline markup. */
  --shadow-sm: none;
  --shadow-md: none;
  --shadow-lg: none;
  --glass-bg: var(--panel);
  --glass-blur: 0px;
}

*, *::before, *::after { box-sizing: border-box; }
* { margin: 0; padding: 0; }
html { min-height: 100%; scroll-padding-top: 88px; }
body {
  min-width: 0;
  min-height: 100vh;
  background: var(--bg);
  color: var(--text);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
  font-size: 14px;
  line-height: 1.65;
  overflow-wrap: anywhere;
}
.hidden, [hidden], .section-tab-panel[hidden] { display: none !important; }
a { color: var(--accent); text-underline-offset: 3px; }
a:hover { color: var(--accent-hover); }
strong { font-weight: 600; }
code, pre, .mono, td.mono { font-family: var(--mono); font-size: 12px; }
code { overflow-wrap: anywhere; }
pre { max-width: 100%; overflow: auto; tab-size: 2; }
img, svg { max-width: 100%; }
::selection { color: var(--text); background: #e4e6f4; }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
:target { scroll-margin-top: 88px; }
button, input, select, textarea, summary { -webkit-tap-highlight-color: transparent; }
button {
  max-width: 100%;
  min-height: 36px;
  padding: 7px 14px;
  border: 1px solid var(--border-strong);
  border-radius: 6px;
  background: var(--panel);
  color: var(--text);
  font: inherit;
  font-size: 13px;
  font-weight: 500;
  line-height: 1.5;
  cursor: pointer;
  transition: background-color .15s, border-color .15s, color .15s;
}
button:hover:not(:disabled) { background: var(--panel-2); border-color: #a8adb8; }
button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
button.primary:hover:not(:disabled) { background: var(--accent-hover); border-color: var(--accent-hover); }
button.danger { color: var(--red); border-color: #e3c3c5; }
button.danger:hover:not(:disabled) { background: var(--red-soft); border-color: var(--red); }
button:disabled, input:disabled, select:disabled, textarea:disabled { opacity: .55; cursor: not-allowed; }
button[aria-busy="true"] { cursor: progress; }
input, select, textarea {
  min-width: 0;
  max-width: 100%;
  min-height: 38px;
  padding: 8px 11px;
  border: 1px solid var(--border-strong);
  border-radius: 6px;
  background: var(--panel);
  color: var(--text);
  font: inherit;
  font-size: 13px;
  line-height: 1.5;
  transition: border-color .15s;
}
input::placeholder, textarea::placeholder { color: #777d87; opacity: 1; }
input:focus, select:focus, textarea:focus { border-color: var(--accent); }
input[readonly], textarea[readonly] { background: var(--panel-2); }
input[aria-invalid="true"], select[aria-invalid="true"], textarea[aria-invalid="true"] { border-color: var(--red); }
input[type="checkbox"], input[type="radio"] {
  flex: 0 0 auto;
  width: 16px;
  height: 16px;
  min-height: 0;
  padding: 0;
  accent-color: var(--accent);
}
textarea { display: block; width: 100%; min-height: 128px; resize: vertical; line-height: 1.65; }
fieldset { min-width: 0; border: 0; }
label { overflow-wrap: anywhere; }
summary { cursor: pointer; user-select: none; }
summary::marker { color: var(--muted); font-size: .85em; }
summary:hover { color: var(--accent); }
summary:focus-visible { outline-offset: -3px; border-radius: 5px; }
details { min-width: 0; }

/* Shell: the scrollable table, not the page, owns intrinsic table width. */
#app, .app-shell { min-width: 0; min-height: 100vh; }
.app-shell { display: flex; align-items: flex-start; }
.sidebar {
  position: sticky;
  top: 0;
  z-index: 30;
  display: flex;
  flex: 0 0 var(--sidebar);
  flex-direction: column;
  width: var(--sidebar);
  height: 100vh;
  height: 100dvh;
  background: var(--panel);
  border-right: 1px solid var(--border);
}
.sidebar-brand { display: flex; align-items: center; gap: 12px; min-height: 90px; padding: 24px 20px; }
.sidebar-brand > div { min-width: 0; }
.sidebar-brand h1 { font-size: 14px; font-weight: 650; line-height: 1.4; }
.sidebar-brand .sub { margin-top: 3px; font-size: 12px; color: var(--muted); }
.logo {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  border-radius: 8px;
  background: var(--accent);
  color: #fff;
  font-size: 17px;
  font-weight: 700;
}
.nav { flex: 1; min-height: 0; overflow: auto; padding: 4px 12px 24px; }
.nav-group { padding: 22px 12px 8px; color: var(--muted); font-size: 11px; font-weight: 500; letter-spacing: .06em; }
.nav-item {
  display: flex;
  align-items: center;
  gap: 11px;
  width: 100%;
  min-height: 42px;
  margin: 3px 0;
  padding: 10px 12px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: #555b66;
  text-align: left;
  font-size: 13px;
  font-weight: 400;
}
.nav-item:hover:not(:disabled) { background: var(--panel-2); color: var(--text); }
.nav-item.active, .nav-item[aria-current="page"] { background: var(--accent-soft); color: var(--accent); font-weight: 600; }
.nav-icon, .nav-item .nav-icon {
  display: inline-flex;
  flex: 0 0 18px;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  vertical-align: middle;
}
.nav-icon svg, svg.nav-icon { width: 18px; height: 18px; }
.sidebar-foot { padding: 18px 24px; border-top: 1px solid var(--border); color: var(--muted); font-size: 12px; }
.main { display: flex; flex: 1; flex-direction: column; min-width: 0; min-height: 100vh; }
.topbar {
  position: sticky;
  top: 0;
  z-index: 20;
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px 12px;
  min-height: 68px;
  padding: 14px var(--page-gutter);
  border-bottom: 1px solid var(--border);
  background: var(--panel);
}
.topbar h2 { font-size: 14px; font-weight: 500; }
.topbar .chips { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; min-width: 0; }
.topbar > * { min-width: 0; }
.content { flex: 1; width: 100%; max-width: var(--content-max); min-width: 0; margin-inline: auto; padding: 32px var(--page-gutter) 72px; }
.content > section, .section-tab-panel, .panel > .body, .modal > .body { min-width: 0; max-width: 100%; }
.menu-btn { display: none; flex: 0 0 38px; align-items: center; justify-content: center; width: 38px; height: 38px; padding: 0; font-size: 19px; }
.sidebar-mask { display: none; }

/* Page introductions and the three first-run tasks. */
.page-heading { display: flex; align-items: flex-start; justify-content: space-between; flex-wrap: wrap; gap: 20px 24px; margin-bottom: 28px; }
.page-heading > * { min-width: 0; }
.eyebrow, .page-heading .eyebrow { margin-bottom: 7px; color: var(--muted); font-size: 11px; font-weight: 600; letter-spacing: .08em; }
.page-heading h1 { font-size: 26px; font-weight: 650; line-height: 1.35; letter-spacing: -.025em; }
.page-heading p { max-width: 720px; margin-top: 9px; color: var(--muted); font-size: 13px; line-height: 1.7; }
.page-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; margin-left: auto; padding-top: 4px; }
.onboarding { margin-bottom: 28px; padding: 24px; border: 1px solid var(--border); border-radius: var(--radius); background: var(--panel); }
.onboarding-head { display: flex; align-items: flex-start; justify-content: space-between; flex-wrap: wrap; gap: 12px; margin-bottom: 20px; }
.onboarding-head h2, .onboarding-head h3 { font-size: 15px; font-weight: 600; }
.onboarding-head p { margin-top: 5px; color: var(--muted); font-size: 13px; }
.setup-steps { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; list-style: none; }
.setup-steps > * { min-width: 0; }
.setup-step {
  display: flex;
  align-items: flex-start;
  gap: 11px;
  width: 100%;
  min-width: 0;
  min-height: 104px;
  padding: 16px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--panel);
  text-align: left;
  font-weight: 400;
}
.setup-step:hover:not(:disabled) { border-color: var(--accent); background: var(--panel-2); }
.step-number { display: inline-flex; flex: 0 0 26px; align-items: center; justify-content: center; width: 26px; height: 26px; border: 1px solid var(--border); border-radius: 50%; color: var(--muted); background: var(--panel-2); font-size: 12px; }
.step-copy { display: block; flex: 1; min-width: 0; }
.step-copy strong { display: block; margin: 2px 0 5px; color: var(--text); font-size: 13px; }
.step-copy span { display: block; color: var(--muted); font-size: 12px; font-weight: 400; line-height: 1.6; }
.step-state { flex-shrink: 0; align-self: flex-start; margin-top: 3px; color: var(--muted); font-size: 11px; line-height: 1.6; }
.setup-step.current, .setup-step[aria-current="step"] { border-color: var(--accent); background: var(--accent-soft); }
.setup-step.current .step-number, .setup-step[aria-current="step"] .step-number { border-color: var(--accent); background: var(--accent); color: #fff; }
.setup-step.current .step-state { color: var(--accent); }
.setup-step.complete .step-number { background: var(--green-soft); border-color: #c6dccd; color: var(--green); }
.setup-step.complete .step-state { color: var(--green); }
/* Put the action below the description rather than squeezing both horizontally. */
.setup-step { display: grid; grid-template-columns: 26px minmax(0, 1fr); }
.setup-step .step-state { grid-column: 2; margin-left: 0; }

/* Four primary metrics; secondary figures remain visible without more large cards. */
.grid, .metrics, .metrics-grid, .primary-metrics { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 16px; margin-bottom: 24px; }
.grid > *, .metrics > *, .metrics-grid > *, .primary-metrics > * { min-width: 0; }
.card { min-width: 0; padding: 22px 24px; border: 1px solid var(--border); border-radius: var(--radius); background: var(--panel); }
.k, .card .k { display: flex; align-items: center; gap: 6px; margin-bottom: 10px; color: var(--muted); font-size: 12px; font-weight: 500; }
.card .v { color: var(--text); font-size: 27px; font-weight: 600; line-height: 1.3; font-variant-numeric: tabular-nums; letter-spacing: -.02em; }
.card .d { margin-top: 9px; color: var(--muted); font-size: 12px; line-height: 1.6; }
.secondary-metrics { display: flex; flex-wrap: wrap; gap: 16px 28px; margin-bottom: 28px; padding: 4px 0 16px; border-bottom: 1px solid var(--border); }
.secondary-metrics > * { min-width: 0; flex: 1 1 150px; }
.secondary-metrics .card, .secondary-metrics .config-item { padding: 0; border: 0; border-radius: 0; background: transparent; }
.secondary-metrics .k { margin-bottom: 3px; font-size: 12px; }
.secondary-metrics .v, .secondary-metrics strong { font-size: 16px; font-weight: 600; font-variant-numeric: tabular-nums; }
.secondary-metrics .d { margin-top: 3px; font-size: 12px; }
.panel { min-width: 0; margin-bottom: 24px; border: 1px solid var(--border); border-radius: var(--radius); background: var(--panel); }
/* Do not put overflow:hidden on .panel: it would break a nested sticky save bar. */
.panel > .head { display: flex; align-items: center; flex-wrap: wrap; gap: 8px 14px; padding: 20px 24px; border-bottom: 1px solid var(--border); border-radius: var(--radius) var(--radius) 0 0; }
.panel > .head h2 { font-size: 15px; font-weight: 600; }
.hint, .panel > .head .hint { color: var(--muted); font-size: 12px; line-height: 1.65; }
.panel > .head .hint { max-width: 760px; }
.panel > .body { padding: 24px; }
.config-list { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(220px, 100%), 1fr)); gap: 16px; }
.config-item { min-width: 0; padding: 14px 16px; border: 1px solid var(--border); border-radius: 6px; background: var(--panel-2); }
.config-item .k { margin-bottom: 5px; font-size: 12px; }
.config-item .v { font-size: 13px; overflow-wrap: anywhere; }
.quick-links { display: flex; align-items: center; flex-wrap: wrap; gap: 10px 24px; margin: 20px 0 28px; }
.quick-links a, .quick-links button { display: inline-flex; align-items: center; gap: 8px; min-height: 36px; padding: 5px 0; border: 0; border-radius: 3px; background: transparent; color: var(--accent); font-size: 13px; text-decoration: none; }
.quick-links a:hover, .quick-links button:hover:not(:disabled) { background: transparent; color: var(--accent-hover); text-decoration: underline; }

/* Tabs and page-level filters. Native hidden and details states remain authoritative. */
.section-tabs { display: flex; align-items: center; flex-wrap: wrap; gap: 4px 20px; margin-bottom: 24px; border-bottom: 1px solid var(--border); }
.section-tabs button[role="tab"] { min-height: 44px; padding: 10px 2px; margin-bottom: -1px; border: 0; border-bottom: 2px solid transparent; border-radius: 0; background: transparent; color: var(--muted); }
.section-tabs button[role="tab"]:hover:not(:disabled) { background: transparent; color: var(--text); }
.section-tabs button[role="tab"][aria-selected="true"] { border-bottom-color: var(--accent); color: var(--accent); font-weight: 600; }
.section-tab-panel { scroll-margin-top: 88px; }
.page-tools { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; min-width: 0; margin-bottom: 20px; }
.page-tools > * { min-width: 0; }
.page-tools input[type="search"], .page-tools > input { flex: 1 1 240px; width: 100%; max-width: 420px; }
.page-tools label { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
.page-tools label input { flex: 1; }
.form-disclosure, .advanced-details { margin-bottom: 24px; border: 1px solid var(--border); border-radius: var(--radius); background: var(--panel); }
.form-disclosure > summary, .form-disclosure > details > summary, .advanced-details > summary { padding: 16px 20px; color: var(--text); font-size: 13px; font-weight: 500; }
.form-disclosure[open] > summary, .form-disclosure > details[open] > summary, .advanced-details[open] > summary { border-bottom: 1px solid var(--border); }
.disclosure-body, .advanced-details > .body, .advanced-details > .detail-body, .advanced-details > .details-body, .advanced-details > .advanced-body { min-width: 0; padding: 20px; }
.advanced-details > :not(summary):not(.body):not(.detail-body):not(.details-body):not(.advanced-body):not(.disclosure-body) { margin: 16px 20px; }
.disclosure-body > :last-child, .advanced-details > .body > :last-child { margin-bottom: 0; }
.disclosure-body > .settings-grid { margin-bottom: 20px; }
.disclosure-body > .advanced-details { margin-top: 20px; }
.form-disclosure summary > .small, .advanced-details summary > .small { display: inline-block; margin-left: 12px; color: var(--muted); font-size: 12px; font-weight: 400; }

/* Form fields retain full-width controls while checkbox labels stay horizontal. */
.settings-block { min-width: 0; margin-bottom: 28px; padding: 24px; border: 1px solid var(--border); border-radius: var(--radius); background: var(--panel); }
.settings-block:last-child { margin-bottom: 0; }
.settings-block h3 { margin-bottom: 7px; color: var(--text); font-size: 15px; font-weight: 600; }
.settings-block .lede { max-width: 920px; margin-bottom: 22px; color: var(--muted); font-size: 13px; line-height: 1.75; }
.settings-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); align-items: start; gap: 24px 28px; }
.setting-field, .settings-grid > * { min-width: 0; }
.setting-field > label, .setting-field .field-label { display: block; margin-bottom: 8px; color: var(--text); font-size: 13px; font-weight: 500; line-height: 1.6; }
.setting-field input:not([type="checkbox"]):not([type="radio"]), .setting-field select, .setting-field textarea { width: 100%; max-width: 100%; }
.env, .setting-field .env { font-family: var(--mono); color: var(--muted); font-size: 11px; font-weight: 400; overflow-wrap: anywhere; }
.setting-field > label .env { display: block; margin-top: 3px; }
.setting-field .hint { margin-top: 8px; color: var(--muted); font-size: 12px; line-height: 1.65; }
.field-help { margin-top: 8px; color: var(--muted); font-size: 12px; }
.field-help > summary, .field-help details > summary { width: fit-content; max-width: 100%; padding: 3px 0; color: var(--muted); font-size: 12px; }
.field-help > summary:hover, .field-help details > summary:hover { color: var(--accent); }
.field-help > :not(summary), .field-help details > :not(summary) { margin-top: 6px; }
.field-help .env { display: block; white-space: normal; overflow-wrap: anywhere; }
label.toggle { display: flex; align-items: center; gap: 8px; min-width: 0; color: var(--muted); font-size: 13px; cursor: pointer; user-select: none; }
.setting-check { display: flex; align-items: flex-start; gap: 9px; color: var(--text); font-size: 13px; cursor: pointer; }
.setting-check input { margin-top: 3px; }
.toggle-switch, .setting-field label.toggle-switch {
  position: relative;
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
  min-height: 30px;
  color: var(--text);
  font-size: 13px;
  font-weight: 400;
  cursor: pointer;
}
.toggle-switch input {
  position: absolute;
  width: 1px !important;
  height: 1px;
  min-height: 0;
  margin: 0;
  padding: 0;
  opacity: 0;
}
.toggle-slider { position: relative; display: inline-block; flex: 0 0 36px; width: 36px; height: 20px; border: 1px solid #9fa6b2; border-radius: 12px; background: #a6adb7; transition: background-color .15s, border-color .15s; }
.toggle-slider::after { content: ''; position: absolute; top: 2px; left: 2px; width: 14px; height: 14px; border-radius: 50%; background: #fff; transition: transform .15s; }
.toggle-switch input:checked + .toggle-slider { background: var(--accent); border-color: var(--accent); }
.toggle-switch input:checked + .toggle-slider::after { transform: translateX(16px); }
.toggle-switch input:focus-visible + .toggle-slider { outline: 2px solid var(--accent); outline-offset: 3px; }
.toggle-switch input:disabled + .toggle-slider { opacity: .5; cursor: not-allowed; }
.toggle-switch input:disabled ~ span { color: var(--muted); }
.settings-block.bot-override { border-left: 3px solid #a9afd3; background: var(--panel); }
.settings-savebar {
  position: sticky;
  bottom: 0;
  z-index: 15;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  flex-wrap: wrap;
  gap: 10px 16px;
  min-height: 70px;
  margin-top: 28px;
  padding: 16px 20px;
  padding-bottom: max(16px, env(safe-area-inset-bottom));
  border: 1px solid var(--border);
  border-radius: var(--radius) var(--radius) 0 0;
  background: var(--panel);
}
.save-state { margin-right: auto; color: var(--muted); font-size: 12px; }
.save-state.dirty, .save-state .dirty, .settings-savebar.dirty .save-state { color: var(--yellow); font-weight: 500; }
.settings-savebar .actions { margin-left: auto; }

/* Tables retain their original one-line cells. Expanded content explicitly wraps. */
.table-scroll { min-width: 0; max-width: 100%; overflow-x: auto; border: 1px solid var(--border); border-radius: 6px; background: var(--panel); overscroll-behavior-x: contain; }
table { width: 100%; border-collapse: collapse; font-size: 13px; font-variant-numeric: tabular-nums; }
.table-scroll table { width: auto; min-width: 100%; }
th { padding: 12px 16px; border-bottom: 1px solid var(--border); background: var(--panel-2); color: var(--muted); text-align: left; font-size: 12px; font-weight: 500; white-space: nowrap; }
td { padding: 15px 16px; border-bottom: 1px solid var(--border); vertical-align: middle; }
tr:last-child > td { border-bottom: 0; }
tbody tr:hover { background: #fafaf8; }
.table-scroll td { white-space: nowrap; }
.table-scroll td .err-text { display: inline-block; max-width: 320px; white-space: normal; }
/* Legacy Bot rows used a flex class on td; retain the native table-cell layout. */
td.row { display: table-cell; }
td.row > button { margin: 2px 4px 2px 0; }
.key-identity { min-width: 0; }
.key-identity strong { display: block; color: var(--text); font-size: 13px; font-weight: 500; }
.key-identity small { display: block; margin-top: 4px; color: var(--muted); font-family: var(--mono); font-size: 11px; }
.usage-summary { display: flex; align-items: center; flex-wrap: wrap; gap: 4px 10px; color: var(--muted); font-size: 12px; font-variant-numeric: tabular-nums; }
.usage-summary strong { color: var(--text); font-weight: 500; }
.usage-summary small { color: var(--muted); font-size: 11px; }
td.usage-summary { display: table-cell; }
td.usage-summary strong, td.usage-summary small { display: block; }
td.usage-summary small { margin-top: 4px; }
.row-details { min-width: 0; font-size: 12px; }
.row-details > summary, .row-details > details > summary { width: fit-content; max-width: 100%; padding: 7px 2px; color: var(--accent); font-size: 12px; }
.row-details-body, .table-scroll td .row-details-body {
  width: 360px;
  max-width: min(480px, calc(100vw - 80px));
  min-width: 0;
  margin-top: 8px;
  padding: 16px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--panel-2);
  color: var(--text);
  white-space: normal;
  overflow-wrap: anywhere;
  word-break: normal;
}
.row-details-body .mono, .row-details-body code, .row-details-body .err-text { max-width: 100%; white-space: normal; overflow-wrap: anywhere; }
.row-details-body .actions { flex-wrap: wrap; margin-top: 14px; }
.row-details-body .actions button { white-space: normal; }
.detail-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px 16px; }
.detail-grid > * { min-width: 0; }
.detail-grid .k, .detail-grid dt { display: block; margin-bottom: 4px; color: var(--muted); font-size: 11px; }
.detail-grid .v, .detail-grid dd { margin: 0; font-size: 12px; }
tr.log-expand-row td { padding: 0 !important; border-bottom: 1px solid var(--border); white-space: normal; }
tr.log-expand-row .expand-panel { padding: 20px 24px; border-top: 1px solid var(--border); background: var(--panel-2); white-space: normal; }
tr.log-expand-row .expand-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(200px, 100%), 1fr)); gap: 14px 24px; margin-bottom: 16px; }
tr.log-expand-row .expand-grid > * { min-width: 0; }
tr.log-expand-row .ek { color: var(--muted); font-size: 11px; font-weight: 500; }
tr.log-expand-row .ev { margin-top: 4px; font-size: 13px; overflow-wrap: anywhere; }
tr.log-expand-row .expand-error { margin-top: 12px; padding: 12px 16px; border: 1px solid #e9cfd1; border-radius: 6px; background: var(--red-soft); color: var(--red); font-size: 12px; line-height: 1.65; white-space: pre-wrap; overflow-wrap: anywhere; }
tr.log-expand-row .expand-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 14px; }
.weight-input { width: 72px; min-height: 32px; padding: 5px 8px; text-align: center; font-size: 12px; }
.scope-chip { cursor: help; text-decoration: underline dotted var(--border-strong); text-underline-offset: 4px; }
.scope-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 20px; }
.scope-grid > * { min-width: 0; }
.scope-list, .bind-list { max-height: 260px; overflow: auto; padding: 12px; border: 1px solid var(--border); border-radius: 6px; background: var(--panel-2); }
.bind-list { max-height: 300px; }
.scope-list label, .bind-list label, .setting-field .scope-list label { display: flex; align-items: flex-start; gap: 9px; margin: 0; padding: 7px 2px; color: var(--text); font-size: 13px; font-weight: 400; }
.scope-list input, .bind-list input { margin-top: 3px; }
.pager { display: flex; align-items: center; flex-wrap: wrap; gap: 12px; margin-top: 20px; padding-top: 16px; border-top: 1px solid var(--border); }

/* Shared information and status treatments. */
.row { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; min-width: 0; }
.row > * { min-width: 0; max-width: 100%; }
.spacer { flex: 1; min-width: 0; }
.muted { color: var(--muted); }
.small { font-size: 12px; }
.err-text { color: var(--red); font-size: 12px; line-height: 1.6; overflow-wrap: anywhere; }
.actions { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
.actions button { min-height: 32px; padding: 5px 10px; border-radius: 5px; font-size: 12px; white-space: nowrap; }
.badge { display: inline-block; padding: 3px 8px; border-radius: 4px; background: #eff0ee; color: var(--muted); font-size: 11px; font-weight: 500; line-height: 1.5; }
.badge.active, .badge.success, .badge.s2xx, .badge.ok { background: var(--green-soft); color: var(--green); }
.badge.disabled, .badge.danger, .badge.s5xx { background: var(--red-soft); color: var(--red); }
.badge.gateway, .badge.sdk { background: var(--accent-soft); color: var(--accent); }
.badge.direct, .badge.estimated, .badge.s4xx, .badge.warn { background: var(--yellow-soft); color: var(--yellow); }
.badge.admin { background: #edf3f3; color: var(--accent-2); }
.badge.sand, .badge.bot { background: #f2eff7; color: #705b8a; }
.badge.inherit, .badge.missing { background: #f0f1ef; color: var(--muted); }
.chip { display: inline-flex; align-items: center; gap: 5px; max-width: 100%; padding: 2px 8px; border: 1px solid var(--border); border-radius: 5px; background: transparent; color: var(--muted); font-size: 11px; line-height: 1.6; }
.chip.ok { border-color: #d3e2d7; color: var(--green); }
.chip.bad { border-color: #e8cfd1; color: var(--red); }
.chip.warn { border-color: #e8ddc4; color: var(--yellow); }
.status-line { display: flex; align-items: center; flex-wrap: wrap; gap: 8px 14px; margin: 10px 0 16px; color: var(--muted); font-size: 12px; }
.status-line h2 { color: var(--text); font-size: 14px; font-weight: 600; }
.status-line strong { color: var(--text); font-weight: 500; }
.request-flow { display: flex; align-items: center; flex-wrap: wrap; gap: 10px 20px; margin-bottom: 20px; }
.request-flow > * { min-width: 0; }
.settings-grid.request-flow { display: grid; align-items: start; }
.request-flow .field-label { display: block; margin-bottom: 5px; color: var(--muted); font-size: 12px; font-weight: 500; }
.connection-info { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; min-width: 0; margin-bottom: 20px; color: var(--muted); font-size: 13px; }
.connection-info > .note { flex: 1 1 100%; margin-top: 0; }
.connection-info code { display: inline-block; max-width: 100%; padding: 3px 7px; border: 1px solid var(--border); border-radius: 4px; background: var(--panel-2); color: var(--text); white-space: normal; overflow-wrap: anywhere; vertical-align: middle; }
.callout { margin-bottom: 20px; padding: 14px 18px; border: 1px solid #dce0ee; border-left: 3px solid #a5aed0; border-radius: 6px; background: #f5f6fb; color: var(--text); font-size: 13px; line-height: 1.75; }
.callout strong { color: var(--text); }
.callout.warn, .warn-loud { border-color: #e8ddc4; border-left-color: #c2a46b; background: var(--yellow-soft); }
.warn-loud { margin: 16px 0; padding: 16px 18px; border: 1px solid #e8ddc4; border-radius: 6px; color: var(--yellow); font-size: 13px; line-height: 1.75; }
.warn-loud strong { color: #76581d; }
.note { margin-top: 10px; color: var(--muted); font-size: 12px; line-height: 1.75; }
.secret-box { margin-bottom: 20px; padding: 18px 20px; border: 1px solid #c9dfd0; border-radius: 6px; background: var(--green-soft); }
.secret-box .mono { font-size: 13px; overflow-wrap: anywhere; }
.global-error { display: flex; align-items: flex-start; flex-wrap: wrap; gap: 8px 16px; margin-bottom: 24px; padding: 14px 18px; border: 1px solid #e8cfd1; border-left: 3px solid var(--red); border-radius: 6px; background: var(--red-soft); color: var(--red); font-size: 13px; }
.global-error > * { min-width: 0; }
.global-error strong { display: block; }
.global-error p { margin-top: 3px; }
.global-error button { margin-left: auto; }
.empty { padding: 40px 20px; color: var(--muted); text-align: center; font-size: 13px; }
.empty-state { display: flex; align-items: center; flex-direction: column; gap: 10px; padding: 48px 24px; color: var(--muted); text-align: center; }
.empty-state strong { color: var(--text); font-size: 15px; font-weight: 500; }
.empty-state p { max-width: 460px; color: var(--muted); font-size: 13px; line-height: 1.75; }
.empty-state button { margin-top: 6px; }
#test-result, #bot-chat-result, .log-detail { max-width: 100%; margin-top: 16px; padding: 16px; border: 1px solid var(--border); border-radius: 6px; background: var(--panel-2); color: var(--text); font-family: var(--mono); font-size: 12px; line-height: 1.7; white-space: pre-wrap; overflow-wrap: anywhere; }
.log-detail { color: var(--muted); }
details.help-details { margin-top: 16px; border: 1px solid var(--border); border-radius: 6px; }
details.help-details summary { padding: 12px 16px; border-radius: 6px; background: var(--panel-2); color: var(--muted); font-size: 13px; }
details.help-details summary:hover { color: var(--text); }
details.help-details .detail-body { padding: 16px; color: var(--muted); font-size: 12px; line-height: 1.8; }

/* Login, announcements and the existing .modal > .head/.body/.foot contract. */
#login { position: fixed; inset: 0; z-index: 50; display: flex; align-items: center; justify-content: center; overflow-y: auto; padding: 24px; background: var(--bg); }
.login-card { width: 400px; max-width: 100%; margin-block: auto; padding: 36px; border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--panel); }
.login-card .logo { width: 42px; height: 42px; margin-bottom: 24px; font-size: 20px; }
.login-card h1 { margin-bottom: 10px; font-size: 21px; font-weight: 600; line-height: 1.45; }
.login-card p { margin-bottom: 24px; color: var(--muted); font-size: 13px; line-height: 1.7; }
.login-card input { width: 100%; min-height: 42px; margin-bottom: 16px; }
.login-card button { width: 100%; min-height: 42px; font-size: 14px; }
.login-err { min-height: 20px; margin-bottom: 8px; color: var(--red); font-size: 12px; }
#toast { position: fixed; right: 24px; bottom: 24px; z-index: 99; display: flex; flex-direction: column; gap: 10px; width: max-content; max-width: min(440px, calc(100vw - 48px)); max-height: calc(100dvh - 48px); overflow-y: auto; pointer-events: none; }
.toast { padding: 13px 16px; border: 1px solid var(--border-strong); border-left: 3px solid var(--accent); border-radius: 6px; background: var(--panel); color: var(--text); font-size: 13px; overflow-wrap: anywhere; pointer-events: auto; animation: toast-in .15s ease-out; }
.toast.bad { border-left-color: var(--red); }
@keyframes toast-in { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }
#modal-mask { position: fixed; inset: 0; z-index: 80; display: flex; align-items: center; justify-content: center; padding: 24px; overflow-y: auto; background: rgb(30 34 43 / 36%); }
.modal { display: flex; flex-direction: column; width: 720px; max-width: 100%; min-width: 0; max-height: calc(100vh - 48px); max-height: calc(100dvh - 48px); border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--panel); overflow: hidden; }
.modal .head { display: flex; flex-shrink: 0; align-items: center; flex-wrap: wrap; gap: 10px; padding: 20px 24px; border-bottom: 1px solid var(--border); }
.modal .head h2 { min-width: 0; font-size: 16px; font-weight: 600; }
.modal > .body { min-height: 0; padding: 24px; overflow-y: auto; overscroll-behavior-y: contain; }
.modal .foot { display: flex; flex-shrink: 0; justify-content: flex-end; flex-wrap: wrap; gap: 8px; padding: 16px 24px; border-top: 1px solid var(--border); }
/* Optional drawer: put .drawer on #modal-mask or .modal. */
#modal-mask.drawer { justify-content: flex-end; padding: 0; }
#modal-mask.drawer .modal, #modal-mask .modal.drawer { width: 620px; height: 100vh; height: 100dvh; max-height: 100dvh; margin-left: auto; border-radius: 0; }
#modal-mask:has(> .modal.drawer) { padding: 0; }

@media (max-width: 1180px) {
  :root { --page-gutter: 24px; }
  .grid, .metrics, .metrics-grid, .primary-metrics { gap: 12px; }
  .card { padding: 20px 16px; }
  .setup-step { flex-wrap: wrap; gap: 8px; padding: 14px; }
  .step-state { margin-left: 34px; }
  .step-copy .step-state { margin-left: 0; }
}
@media (max-width: 900px) {
  .sidebar { position: fixed; left: 0; top: 0; max-width: calc(100vw - 48px); visibility: hidden; transform: translateX(-100%); transition: transform .2s ease, visibility .2s; }
  .sidebar.open { visibility: visible; transform: none; }
  .sidebar-mask { position: fixed; inset: 0; z-index: 25; display: block; background: rgb(30 34 43 / 30%); }
  .menu-btn { display: inline-flex; }
  .topbar .chips .chip-extra { display: none; }
  .content { padding-top: 24px; padding-bottom: 56px; }
  .grid, .metrics, .metrics-grid, .primary-metrics { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .settings-grid, .scope-grid { grid-template-columns: minmax(0, 1fr); }
  .setup-step { min-height: 116px; }
  /* Legacy forms include inline pixel minima; remove them before narrow wrapping. */
  .content :is(input, select, textarea, label, div)[style*="min-width"],
  .modal :is(input, select, textarea, label, div)[style*="min-width"] { min-width: 0 !important; max-width: 100%; }
}
@media (max-width: 600px) {
  :root { --page-gutter: 16px; }
  html { scroll-padding-top: 132px; }
  .topbar { gap: 8px; padding: 12px 16px; }
  .topbar .chips { display: none; }
  .topbar label.toggle { font-size: 12px; }
  .topbar > button:not(.menu-btn) { padding-inline: 10px; }
  .content { padding-top: 24px; }
  .page-heading { gap: 16px; margin-bottom: 24px; }
  .page-heading h1 { font-size: 24px; }
  .page-actions { width: 100%; margin-left: 0; padding-top: 0; }
  .onboarding { padding: 20px 16px; }
  .setup-steps { grid-template-columns: minmax(0, 1fr); }
  .setup-step { flex-wrap: nowrap; align-items: flex-start; min-height: 86px; padding: 16px; gap: 10px; }
  .step-state { margin-left: 0; }
  .grid, .metrics, .metrics-grid, .primary-metrics { gap: 12px; }
  .card { padding: 18px 14px; }
  .card .v { font-size: 23px; }
  .card .k { font-size: 11px; }
  .secondary-metrics { gap: 16px; }
  .secondary-metrics > * { flex-basis: calc(50% - 16px); }
  .panel > .head, .panel > .body { padding: 20px 16px; }
  .settings-block { padding: 20px 16px; }
  .settings-grid, .config-list, .detail-grid { grid-template-columns: minmax(0, 1fr); }
  .settings-grid { gap: 22px; }
  .page-tools { align-items: stretch; flex-direction: column; }
  .page-tools > input, .page-tools input[type="search"] { flex-basis: auto; max-width: 100%; }
  .page-tools > *, .page-tools label { width: 100%; }
  .section-tabs { gap: 4px 16px; }
  .section-tabs button[role="tab"] { max-width: 100%; font-size: 12px; }
  .form-disclosure > summary, .form-disclosure > details > summary, .advanced-details > summary { padding: 14px 16px; }
  .disclosure-body, .advanced-details > .body, .advanced-details > .detail-body, .advanced-details > .details-body, .advanced-details > .advanced-body { padding: 16px; }
  .advanced-details > :not(summary):not(.body):not(.detail-body):not(.details-body):not(.advanced-body):not(.disclosure-body) { margin: 16px; }
  /* Only form-like rows stack; table cells and action groups retain their own layout. */
  .row:not(td):has(> input, > select, > textarea, > .setting-field) { flex-direction: column; align-items: stretch; }
  .row:not(td) > input:not([type="checkbox"]):not([type="radio"]),
  .row:not(td) > select, .row:not(td) > textarea, .row:not(td) > .setting-field { flex: 0 1 auto !important; width: 100% !important; }
  .row:not(td) > label.toggle { flex-wrap: wrap; }
  input:not([type="checkbox"]):not([type="radio"]), select, textarea { font-size: 16px; }
  .weight-input { font-size: 13px !important; }
  .settings-savebar { gap: 10px; padding: 14px 16px; padding-bottom: max(14px, env(safe-area-inset-bottom)); }
  .save-state { flex: 1 1 100%; }
  .settings-savebar button { flex: 1; }
  .settings-savebar .actions { width: 100%; }
  .request-flow { align-items: stretch; flex-direction: column; gap: 14px; }
  .request-flow input, .request-flow select { width: 100%; }
  .quick-links { gap: 12px 20px; }
  .empty-state { padding: 36px 16px; }
  th, td { padding: 12px; }
  .row-details-body, .table-scroll td .row-details-body { max-width: calc(100vw - 88px); padding: 12px; }
  tr.log-expand-row .expand-panel { padding: 16px; }
  .callout, .warn-loud, .secret-box { padding: 14px; }
  #login { padding: 20px; }
  .login-card { padding: 28px 24px; }
  #toast { right: 16px; bottom: max(16px, env(safe-area-inset-bottom)); max-width: calc(100vw - 32px); }
  #modal-mask { padding: 12px; }
  .modal { max-height: calc(100vh - 24px); max-height: calc(100dvh - 24px); border-radius: 8px; }
  .modal .head, .modal > .body { padding: 18px 16px; }
  .modal .foot { padding: 14px 16px; }
  #modal-mask.drawer .modal, #modal-mask .modal.drawer { width: 100%; }
}
@media (max-width: 360px) {
  .grid, .metrics, .metrics-grid, .primary-metrics { grid-template-columns: minmax(0, 1fr); }
  .setup-step { flex-wrap: wrap; }
  .step-state { margin-left: 36px; }
  .step-copy .step-state { margin-left: 0; }
}
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation: none !important; transition: none !important; scroll-behavior: auto !important; }
}
@media (forced-colors: active) {
  :focus-visible, .toggle-switch input:focus-visible + .toggle-slider { outline-color: Highlight; }
  .toggle-slider { forced-color-adjust: none; background: Canvas; border-color: ButtonText; }
  .toggle-slider::after { background: ButtonText; }
  .toggle-switch input:checked + .toggle-slider { background: Highlight; border-color: Highlight; }
  .toggle-switch input:checked + .toggle-slider::after { background: HighlightText; }
}
`;
