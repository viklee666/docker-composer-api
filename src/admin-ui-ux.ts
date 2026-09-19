/** Task-oriented presentation helpers. Runs in the admin page's existing closure. */
export const ADMIN_UX_SCRIPT = String.raw`
  var uiDirty = {};
  var uiRevision = {};
  var uiLastFocus = null;
  var uiDescriptions = {
    dashboard: ['工作台', '先完成接入，再关注运行状态。'],
    keys: ['上游凭据', 'Cursor Key 供网关调用模型使用，不要将它作为网关密钥分发给客户端。'],
    'gateway-keys': ['客户端密钥', '在这里创建网关密钥，供你的聊天或开发客户端访问本服务。'],
    bot: ['Bot 通道', '管理 Bot 连接凭据。使用这条通道时，优先从已有 Cursor Key 兑换。'],
    history: ['请求记录', '查看调用结果与用量；完整错误和调试信息放在每条记录的详情里。'],
    diagnostics: ['连接测试', '选择通道与模型，发送一次真实请求，确认连接能够正常工作。'],
    routing: ['路由策略', '决定多把上游 Key 的取用顺序，以及同一会话是否复用同一把 Key。'],
    'system-prompt': ['系统提示词', '为客户端请求设置默认指令；不需要额外指令时保持关闭。'],
    proxy: ['网络代理', '配置网关访问上游服务的网络路径，并分别验证接口与模型连接。'],
    settings: ['运行设置', '按任务分类调整参数。修改不会自动保存，保存后作用于后续请求。']
  };
  function isUiDirty(name){ return !!uiDirty[name]; }
  function setUiDirty(name, value){
    uiDirty[name] = value;
    if (value) uiRevision[name] = (uiRevision[name] || 0) + 1;
    var state = $('save-state-' + name);
    if (state) {
      state.textContent = value ? '有未保存的修改' : '修改后保存，立即用于后续请求';
      state.classList.toggle('dirty', value);
    }
  }
  function uiSaveTarget(path, body){
    if (path === '/admin/api/quota-buckets' && body) return 'quota';
    if (path !== '/admin/api/settings' || !body) return '';
    if ('systemPromptText' in body) return 'system-prompt';
    if ('routingStrategy' in body) return 'routing';
    if ('proxyUrl' in body) return 'proxy';
    // A partial action (for example enabling HTTP/1.1 from the proxy page)
    // must not mark the entire runtime settings form as saved.
    return 'cursorSdkSessionMode' in body ? 'settings' : '';
  }
  function uiPageChanged(name){
    var info = uiDescriptions[name] || uiDescriptions.dashboard;
    $('page-title').textContent = info[0];
    $('page-description').textContent = info[1];
    $('crumb').textContent = info[0];
    document.title = info[0] + ' · Composer API';
    document.querySelectorAll('[data-nav]').forEach(function(button){
      if (button.dataset.nav === name) button.setAttribute('aria-current', 'page');
      else button.removeAttribute('aria-current');
    });
    var actions = $('page-actions');
    actions.replaceChildren();
    var form = name === 'keys' ? 'add-key-form' : name === 'gateway-keys' && gwPoolEnabled ? 'add-gw-form' : '';
    if (form) {
      var button = document.createElement('button');
      button.className = 'primary';
      button.textContent = name === 'keys' ? '+ 添加上游凭据' : '+ 创建客户端密钥';
      button.addEventListener('click', function(){ openUiForm(form); });
      actions.appendChild(button);
    }
  }
  function openUiForm(id){
    var form = $(id);
    form.open = true;
    form.scrollIntoView({ block: 'nearest' });
    var first = form.querySelector('input');
    if (first) first.focus({ preventScroll: true });
  }
  function uiOverview(data){
    var upstream = !!(data.keys && data.keys.active > 0);
    var client = !!(data.gatewayKeys && data.gatewayKeys.active > 0);
    var success = !!(data.requests && data.requests.success > 0);
    var states = [upstream, client, success];
    ['setup-upstream', 'setup-client', 'setup-test'].forEach(function(id, index){
      var step = $(id);
      step.classList.toggle('complete', states[index]);
      step.classList.toggle('current', !states[index] && states.slice(0, index).every(Boolean));
      step.querySelector('.step-state').textContent = states[index]
        ? (index === 2 ? '已有成功请求 · 再次测试 →' : '已就绪 · 管理 →')
        : (index === 2 ? '发送测试 →' : '前往配置 →');
    });
    if (!data.gatewayKeys) $('setup-client').querySelector('.step-state').textContent = '查看单密钥接入说明 →';
    $('setup-progress').textContent = states.filter(Boolean).length + ' / 3 项已就绪';
    $('last-updated').textContent = '更新于 ' + new Date().toLocaleTimeString('zh-CN', { hour12: false }) + ' · 每 10 秒自动刷新';
    $('chip-status').textContent = '服务已连接';
    $('chip-status').className = 'chip ok';
    $('global-error').classList.add('hidden');
    if (currentSection === 'gateway-keys') uiPageChanged(currentSection);
  }
  function filterKeyRows(){
    var query = $('key-search').value.trim().toLowerCase();
    var count = 0;
    $('keys-body').querySelectorAll('tr[data-key-search]').forEach(function(row){
      row.hidden = row.dataset.keySearch.toLowerCase().indexOf(query) < 0;
      if (!row.hidden) count++;
    });
    if (lastKeys.length) {
      $('keys-empty').textContent = '没有匹配的凭据，请换个关键词。';
      $('keys-empty').classList.toggle('hidden', count > 0);
    } else {
      $('keys-empty').textContent = '还没有上游凭据。点击“添加上游凭据”，或展开下方的 Session Token 换取方式。';
    }
  }
  function makeUiTabs(host, id, groups){
    var tabs = document.createElement('div');
    tabs.className = 'section-tabs';
    tabs.setAttribute('role', 'tablist');
    tabs.setAttribute('aria-label', id === 'settings' ? '设置分类' : 'Bot 通道分类');
    var panels = document.createElement('div');
    host.prepend(panels);
    host.prepend(tabs);
    groups.forEach(function(group, index){
      var tab = document.createElement('button');
      tab.type = 'button';
      tab.id = id + '-tab-' + index;
      tab.textContent = group[0];
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-controls', id + '-panel-' + index);
      var panel = document.createElement('div');
      panel.id = id + '-panel-' + index;
      panel.className = 'section-tab-panel';
      panel.setAttribute('role', 'tabpanel');
      panel.setAttribute('aria-labelledby', tab.id);
      group[1].forEach(function(node){ if (node) panel.appendChild(node); });
      tabs.appendChild(tab);
      panels.appendChild(panel);
      function select(){
        Array.from(tabs.children).forEach(function(button, n){
          button.setAttribute('aria-selected', String(n === index));
          button.tabIndex = n === index ? 0 : -1;
          panels.children[n].hidden = n !== index;
        });
        // Quota buckets have their own save endpoint; startup values are read-only.
        if (id === 'settings') {
          var savebar = host.querySelector('.settings-savebar');
          if (savebar) savebar.hidden = index >= 5;
        }
      }
      tab.addEventListener('click', select);
      tab.addEventListener('keydown', function(event){
        var next;
        if (event.key === 'ArrowRight') next = (index + 1) % groups.length;
        if (event.key === 'ArrowLeft') next = (index + groups.length - 1) % groups.length;
        if (event.key === 'Home') next = 0;
        if (event.key === 'End') next = groups.length - 1;
        if (next != null) { event.preventDefault(); tabs.children[next].click(); tabs.children[next].focus(); }
      });
      tab.setAttribute('aria-selected', String(index === 0));
      tab.tabIndex = index === 0 ? 0 : -1;
      panel.hidden = index !== 0;
    });
  }
  function foldUiPanel(panel, title){
    if (!panel) return;
    var details = document.createElement('details');
    details.className = 'advanced-details';
    var summary = document.createElement('summary');
    summary.textContent = title;
    details.appendChild(summary);
    var body = panel.querySelector(':scope > .body');
    panel.replaceWith(details);
    if (body) details.appendChild(body);
  }
  function setupUiSettings(){
    var section = $('sec-settings');
    var host = section.querySelector('.panel > .body');
    var blocks = Array.from(host.querySelectorAll(':scope > .settings-block'));
    var boot = section.querySelectorAll(':scope > .panel')[1];
    makeUiTabs(host, 'settings', [
      ['会话与缓存', [blocks[0]]], ['请求与安全', [blocks[1], blocks[4]]],
      ['模型默认', [blocks[2]]], ['Bot 覆盖', [blocks[3]]],
      ['调试快照', [blocks[5]]], ['额度分桶', [blocks[6]]], ['启动环境', [boot]]
    ]);
    var savebar = $('btn-save-settings').parentElement;
    savebar.className = 'settings-savebar';
    savebar.removeAttribute('style');
    var state = document.createElement('span');
    state.id = 'save-state-settings';
    state.className = 'save-state';
    state.setAttribute('role', 'status');
    savebar.prepend(state);
    setUiDirty('settings', false);
    // Technical explanations remain accessible without occupying the entire form.
    section.querySelectorAll('.setting-field').forEach(function(field){
      var hint = field.querySelector(':scope > .hint');
      var env = field.querySelector('.env');
      var input = field.querySelector('input, select, textarea');
      var label = field.querySelector('label');
      if (label && input && input.id) label.htmlFor = input.id;
      if (!hint && !env) return;
      var help = document.createElement('details');
      help.className = 'field-help';
      var summary = document.createElement('summary');
      summary.textContent = '说明与环境变量';
      help.appendChild(summary);
      // Keep tool execution warnings visible rather than hiding safety information.
      if (hint && !(input && input.id === 'builtin-tools-toggle')) help.appendChild(hint);
      if (env) help.appendChild(env);
      field.appendChild(help);
    });
    blocks.forEach(function(block){
      var lede = block.querySelector(':scope > .lede');
      if (!lede) return;
      var details = document.createElement('details');
      details.className = 'field-help';
      var summary = document.createElement('summary');
      summary.textContent = '了解生效规则';
      lede.replaceWith(details);
      details.append(summary, lede);
    });
    ['fast', 'max-mode'].forEach(function(dim){
      var list = $(dim + '-models-list');
      var search = document.createElement('input');
      search.id = dim + '-models-search';
      search.type = 'search';
      search.placeholder = '搜索模型';
      search.setAttribute('aria-label', '搜索 ' + dim + ' 模型');
      search.addEventListener('input', function(){ filterPolicyModels(dim); });
      list.before(search);
    });
  }
  function filterPolicyModels(dim){
    var search = $(dim + '-models-search');
    if (!search) return;
    var query = search.value.trim().toLowerCase();
    $(dim + '-models-list').querySelectorAll('label').forEach(function(label){
      label.hidden = label.textContent.toLowerCase().indexOf(query) < 0;
    });
  }
  function setupUiBot(){
    var section = $('sec-bot');
    var panels = Array.from(section.querySelectorAll(':scope > .panel'));
    makeUiTabs(section, 'bot', [['连接凭据', [panels[0]]], ['模型目录', [panels[3]]], ['对话测试', [panels[1]]], ['任务记录', [panels[4]]], ['生效配置', [panels[2]]]]);
    var host = panels[0].querySelector('.body');
    var manual = document.createElement('details');
    manual.className = 'advanced-details';
    var summary = document.createElement('summary');
    summary.textContent = '其他接入方式：手动导入桌面端 Token';
    manual.appendChild(summary);
    var content = document.createElement('div');
    content.className = 'body';
    manual.appendChild(content);
    var tokenRow = $('bot-token').parentElement;
    host.insertBefore(manual, tokenRow);
    var warning = host.querySelector('.callout.warn');
    if (warning) content.appendChild(warning);
    var tools = document.createElement('div');
    tools.className = 'row';
    tools.append($('btn-bot-script-download'), $('btn-bot-script-view'));
    content.appendChild(tools);
    host.querySelectorAll(':scope > p.note').forEach(function(note){ content.appendChild(note); });
    content.append($('bot-script-source'), tokenRow);
    $('bot-token').type = 'password';
    var help = document.createElement('p');
    help.className = 'note';
    help.textContent = '推荐：选择已有 Cursor Key 并拉取凭据，后续会自动续期。手动导入方式见下方。';
    $('bot-from-key').parentElement.before(help);
    panels[0].querySelector('.head .hint').textContent = '与 Cursor SDK 分开的调用通道，使用 Bot 专用凭据。';
  }
  function setupUiDiagnostics(){
    var row = $('test-provider').parentElement;
    row.className = 'settings-grid request-flow';
    [['test-provider', '01 · 调用通道'], ['test-key', '上游凭据'], ['test-model', '02 · 模型'], ['test-prompt', '03 · 测试内容']].forEach(function(item){
      var input = $(item[0]);
      var field = document.createElement('div');
      field.className = 'setting-field';
      var label = document.createElement('label');
      label.htmlFor = item[0];
      label.textContent = item[1];
      input.before(field);
      input.removeAttribute('style');
      field.append(label, input);
    });
    var footer = document.createElement('div');
    footer.className = 'row';
    footer.style.marginTop = '24px';
    footer.appendChild($('btn-test'));
    var notice = document.createElement('span');
    notice.className = 'muted small';
    notice.textContent = '会消耗上游额度；首次连接可能需要较长时间。';
    footer.appendChild(notice);
    row.after(footer);
  }
  function setupUiHistory(){
    var filters = $('log-model').parentElement;
    filters.className = 'page-tools';
    var more = document.createElement('details');
    more.className = 'advanced-details';
    var summary = document.createElement('summary');
    summary.textContent = '更多筛选条件';
    more.appendChild(summary);
    var body = document.createElement('div');
    body.className = 'row';
    ['log-key', 'log-gw', 'log-limit'].forEach(function(id){ body.appendChild($(id)); });
    more.appendChild(body);
    filters.after(more);
    [['log-model', '模型'], ['log-outcome', '请求结果'], ['log-since', '时间范围'], ['log-key', '上游凭据'], ['log-gw', '客户端密钥'], ['log-limit', '每页记录数']].forEach(function(pair){ $(pair[0]).setAttribute('aria-label', pair[1]); });
  }
  function initAdminUx(){
    var iconPaths = {
      dashboard: 'M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z',
      history: 'M8 4h12v17H4V4h4 M8 2h8v4H8z M8 11h8 M8 15h6',
      keys: 'M14 3a6 6 0 1 0 4 10l3-3 M10 13l-7 7v-4l5-5 M16 7h.01',
      'gateway-keys': 'M12 3l8 4v5c0 5-8 9-8 9s-8-4-8-9V7z M9 12l2 2 4-4',
      diagnostics: 'M3 12h4l3-8 4 16 3-8h4',
      bot: 'M5 7h14v13H5z M12 3v4 M9 12h.01 M15 12h.01 M9 16h6',
      routing: 'M5 3v13a4 4 0 0 0 4 4h10 M5 10h10a4 4 0 0 0 4-4V3 M16 17l3 3-3 3',
      'system-prompt': 'M4 4h16v13H8l-4 4z M8 8h8 M8 12h5',
      proxy: 'M8 8H5v11h14V8h-3 M12 3v11 M8 7l4-4 4 4',
      settings: 'M4 7h16 M4 17h16 M8 4v6 M16 14v6'
    };
    document.querySelectorAll('[data-nav]').forEach(function(button){
      var icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      icon.setAttribute('viewBox', '0 0 24 24'); icon.setAttribute('fill', 'none'); icon.setAttribute('stroke', 'currentColor'); icon.setAttribute('stroke-width', '1.6'); icon.setAttribute('stroke-linecap', 'round'); icon.setAttribute('stroke-linejoin', 'round'); icon.setAttribute('class', 'nav-icon'); icon.setAttribute('aria-hidden', 'true');
      var path = document.createElementNS('http://www.w3.org/2000/svg', 'path'); path.setAttribute('d', iconPaths[button.dataset.nav]); icon.appendChild(path); button.prepend(icon);
    });
    setupUiSettings(); setupUiBot(); setupUiDiagnostics(); setupUiHistory();
    [['routing', 'btn-save-routing'], ['system-prompt', 'btn-save-sys'], ['proxy', 'btn-save-proxy'], ['quota', 'btn-save-quota-buckets']].forEach(function(pair){
      var state = document.createElement('span');
      state.id = 'save-state-' + pair[0];
      state.className = 'save-state';
      state.setAttribute('role', 'status');
      $(pair[1]).parentElement.appendChild(state);
      setUiDirty(pair[0], false);
    });
    foldUiPanel($('mint-token').closest('.panel'), '没有 API Key？使用 Session Token 换取');
    $('key-search').addEventListener('input', filterKeyRows);
    $('client-base-url').textContent = location.origin + '/v1';
    $('copy-base-url').addEventListener('click', function(){ copyText($('client-base-url').textContent); });
    $('retry-load').addEventListener('click', loadAll);
    document.addEventListener('click', function(event){
      var go = event.target.closest('[data-go]');
      if (go) { showSection(go.dataset.go); $('page-title').focus({ preventScroll: true }); }
      var cancel = event.target.closest('[data-close-disclosure]');
      if (cancel) { var form = $(cancel.dataset.closeDisclosure); form.open = false; form.querySelector('summary').focus(); }
    });
    document.addEventListener('input', trackUiChanges);
    document.addEventListener('change', trackUiChanges);
    function trackUiChanges(event){
      var section = event.target.closest('[data-section]');
      if (!section) return;
      var name = section.dataset.section;
      if (['settings', 'routing', 'system-prompt', 'proxy'].indexOf(name) < 0) return;
      if (event.target.type === 'search') return;
      setUiDirty(event.target.id === 'quota-buckets-json' ? 'quota' : name, true);
    }
    window.addEventListener('beforeunload', function(event){
      if (Object.keys(uiDirty).some(function(key){ return uiDirty[key]; })) { event.preventDefault(); event.returnValue = ''; }
    });
    // Keep keyboard focus inside the existing modal, and restore it on close.
    var mask = $('modal-mask');
    mask.querySelector('.modal').setAttribute('aria-labelledby', 'modal-title');
    new MutationObserver(function(){
      var open = !mask.classList.contains('hidden');
      $('app').inert = open;
      if (open) { uiLastFocus = document.activeElement; $('modal-close').focus(); }
      else if (uiLastFocus && uiLastFocus.isConnected) { uiLastFocus.focus(); uiLastFocus = null; }
    }).observe(mask, { attributes: true, attributeFilter: ['class'] });
    document.addEventListener('keydown', function(event){
      if (event.key === 'Escape') { closeMenu(); if (!mask.classList.contains('hidden')) closeModal(); }
      if (event.key !== 'Tab' || mask.classList.contains('hidden')) return;
      var nodes = Array.from(mask.querySelectorAll('button, input, select, textarea, [tabindex="0"]')).filter(function(node){ return !node.disabled && node.getClientRects().length; });
      var first = nodes[0], last = nodes[nodes.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    });
    $('toast').setAttribute('role', 'status');
    $('toast').setAttribute('aria-live', 'polite');
    $('login-err').setAttribute('role', 'alert');
    $('login-pass').setAttribute('aria-label', '管理密码');
    document.querySelectorAll('input, select, textarea').forEach(function(input){
      if (!input.getAttribute('aria-label') && !input.labels.length) input.setAttribute('aria-label', input.placeholder || input.title || input.id);
    });
  }
`;
