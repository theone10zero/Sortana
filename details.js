const aiLog = (await import(browser.runtime.getURL("logger.js"))).aiLog;
const storage = (globalThis.messenger ?? browser).storage;
const { detectSystemTheme } = await import(browser.runtime.getURL('modules/themeUtils.js'));
const { t, applyToDocument, currentLocale } = await import(browser.runtime.getURL('modules/i18n.js'));
document.documentElement.lang = currentLocale();
applyToDocument(document);
const { theme } = await storage.local.get('theme');
const mode = (theme || 'auto') === 'auto'
  ? await detectSystemTheme()
  : theme;
document.documentElement.dataset.theme = mode;

const qMid = parseInt(new URLSearchParams(location.search).get("mid"), 10);
if (!isNaN(qMid)) {
  loadMessage(qMid);
} else {
  const { ids } = await browser.runtime.sendMessage({
    type: "sortana:getDisplayedMessages",
  });
  if (ids && ids[0]) {
    loadMessage(ids[0]);
  } else {
      const tabs = await browser.tabs.query({ active: true, currentWindow: true });
      const tabId = tabs[0]?.id;
      const msgs = tabId ? await browser.messageDisplay.getDisplayedMessages(tabId) : [];
      let id = msgs[0]?.id;
      if (id) {
          loadMessage(id);
      }
      else {
          aiLog("Details popup: no displayed message found");
      }
  }
}

async function loadMessage(id) {
  const storage = (globalThis.messenger ?? browser).storage;
  const logMod = await import(browser.runtime.getURL('logger.js'));
  const { debugLogging } = await storage.local.get('debugLogging');
  logMod.setDebug(debugLogging === true);
  const log = logMod.aiLog;

  log('details page loaded', { debug: true });
  try {
    log('requesting message details', {}, id);
    const { subject, results } = await browser.runtime.sendMessage({ type: 'sortana:getDetails', id });
    log('received details', { debug: true }, { subject, results });
    document.getElementById('subject').textContent = subject;
    const container = document.getElementById('rules');
    for (const r of results) {
      log('rendering rule result', { debug: true }, r);
      const article = document.createElement('article');
      const color = r.matched === true ? 'is-success' : 'is-danger';
      article.className = `message ${color} mb-4`;
      const header = document.createElement('div');
      header.className = 'message-header';
      const criterion = document.createElement('p');
      criterion.textContent = r.criterion;
      header.appendChild(criterion);
      const body = document.createElement('div');
      body.className = 'message-body';
      const status = document.createElement('p');
      status.textContent = r.matched ? t('details.matched') : t('details.notMatched');
      if (r.backend === 'systemone') {
        status.textContent += ' ' + t('details.underThreshold');
        status.classList.add('mb-2');
        body.appendChild(status);
        const percentage = r.probability * 100;
        const bar = document.createElement('div');
        bar.className = `probability-bar ${color}`;
        bar.setAttribute('role', 'progressbar');
        bar.setAttribute('aria-label', 'Match probability');
        bar.setAttribute('aria-valuemin', '0');
        bar.setAttribute('aria-valuemax', '100');
        bar.setAttribute('aria-valuenow', String(percentage));
        bar.title = r.model
          ? t('details.thresholdModelTooltip', { THRESHOLD: r.threshold * 100, MODEL: r.model })
          : t('details.thresholdTooltip', { THRESHOLD: r.threshold * 100 });
        const fill = document.createElement('div');
        fill.className = 'probability-fill';
        fill.style.width = `${percentage}%`;
        const value = document.createElement('span');
        value.className = 'probability-value';
        value.textContent = `${percentage.toFixed(2)}%`;
        bar.append(fill, value);
        body.appendChild(bar);
      } else {
        const pre = document.createElement('pre');
        pre.textContent = r.reason || '';
        body.append(status, pre);
      }
      article.appendChild(header);
      article.appendChild(body);
      container.appendChild(article);
    }
    document.getElementById('clear').addEventListener('click', async () => {
      log('clearing cache for message', {}, id);
      await browser.runtime.sendMessage({ type: 'sortana:clearCacheForMessage', id });
      window.close();
    });
  } catch (e) {
    log('failed to load details', { level: 'error' }, e);
  }
}
