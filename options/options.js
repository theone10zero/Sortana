document.addEventListener('DOMContentLoaded', async () => {
    const storage = (globalThis.messenger ?? browser).storage;
    const logger = await import(browser.runtime.getURL('logger.js'));
    const AiClassifier = await import(browser.runtime.getURL('modules/AiClassifier.js'));
    const dataTransfer = await import(browser.runtime.getURL('options/dataTransfer.js'));
    const { detectSystemTheme } = await import(browser.runtime.getURL('modules/themeUtils.js'));
    const { DEFAULT_AI_PARAMS } = await import(browser.runtime.getURL('modules/defaultParams.js'));
    const defaults = await storage.local.get([
        'endpoint',
        'templateName',
        'customTemplate',
        'customSystemPrompt',
        'aiParams',
        'debugLogging',
        'htmlToMarkdown',
        'stripUrlParams',
        'altTextImages',
        'collapseWhitespace',
        'tokenReduction',
        'aiRules',
        'aiCache',
        'theme',
        'showDebugTab',
        'lastPayload',
        'lastFullText',
        'lastPromptText'
    ]);
    const tabButtons = document.querySelectorAll('#main-tabs li');
    const tabs = document.querySelectorAll('.tab-content');
    tabButtons.forEach(btn => btn.addEventListener('click', () => {
        tabButtons.forEach(b => b.classList.remove('is-active'));
        btn.classList.add('is-active');
        tabs.forEach(tab => {
            tab.classList.toggle('is-hidden', tab.id !== `${btn.dataset.tab}-tab`);
        });
    }));
    tabButtons[0]?.click();

    const saveBtn = document.getElementById('save');
    let initialized = false;
    let dragRule = null;
    function markDirty() {
        if (initialized) saveBtn.disabled = false;
    }
    document.addEventListener('input', markDirty, true);
    document.addEventListener('change', markDirty, true);
    logger.setDebug(defaults.debugLogging === true);

    const themeSelect = document.getElementById('theme-select');
    themeSelect.value = defaults.theme || 'auto';

    function updateIcons(theme) {
        document.querySelectorAll('img[data-icon]').forEach(img => {
            const name = img.dataset.icon;
            const size = img.dataset.size || 16;
            if (name === 'full-logo') {
                img.src = `../resources/img/full-logo${theme === 'dark' ? '-white' : ''}.png`;
            } else {
                img.src = `../resources/img/${name}-${theme}-${size}.png`;
            }
        });
    }

    async function applyTheme(setting) {
        const mode = setting === 'auto' ? await detectSystemTheme() : setting;
        document.documentElement.dataset.theme = mode;
        updateIcons(mode);
    }

    await applyTheme(themeSelect.value);
    const payloadDisplay = document.getElementById('payload-display');
    const diffDisplay = document.getElementById('diff-display');
    const diffContainer = document.getElementById('diff-container');
    const promptReductionLabel = document.getElementById('prompt-reduction');

    let lastFullText = defaults.lastFullText || '';
    let lastPromptText = defaults.lastPromptText || '';
    let lastPayload = defaults.lastPayload ? JSON.stringify(defaults.lastPayload, null, 2) : '';

    if (lastPayload) {
        payloadDisplay.textContent = lastPayload;
    }
    themeSelect.addEventListener('change', async () => {
        markDirty();
        await applyTheme(themeSelect.value);
    });
    const endpointInput = document.getElementById('endpoint');
    const endpointPreview = document.getElementById('endpoint-preview');
    const fallbackEndpoint = 'http://127.0.0.1:5000';
    const storedEndpoint = defaults.endpoint || fallbackEndpoint;
    const endpointBase = AiClassifier.normalizeEndpointBase(storedEndpoint) || storedEndpoint;
    endpointInput.value = endpointBase;

    function updateEndpointPreview() {
        const resolved = AiClassifier.buildEndpointUrl(endpointInput.value);
        endpointPreview.textContent = resolved
            ? `Resolved endpoint: ${resolved}`
            : 'Resolved endpoint: (invalid)';
    }
    endpointInput.addEventListener('input', updateEndpointPreview);
    updateEndpointPreview();

    const templates = {
        openai: browser.i18n.getMessage('template.openai'),
        qwen: browser.i18n.getMessage('template.qwen'),
        mistral: browser.i18n.getMessage('template.mistral'),
        harmony: browser.i18n.getMessage('template.harmony'),
        custom: browser.i18n.getMessage('template.custom')
    };
    const templateSelect = document.getElementById('template');
    for (const [value, label] of Object.entries(templates)) {
        const opt = document.createElement('option');
        opt.value = value;
        opt.textContent = label;
        templateSelect.appendChild(opt);
    }
    templateSelect.value = defaults.templateName || 'openai';

    const customBox = document.getElementById('custom-template-container');
    const customTemplate = document.getElementById('custom-template');
    customTemplate.value = defaults.customTemplate || '';

    function updateVisibility() {
        customBox.classList.toggle('is-hidden', templateSelect.value !== 'custom');
    }
    templateSelect.addEventListener('change', updateVisibility);
    updateVisibility();

    const advancedBox = document.getElementById('advanced-options');
    const advancedBtn = document.getElementById('toggle-advanced');
    advancedBtn.addEventListener('click', () => {
        advancedBox.classList.toggle('is-hidden');
    });

    const debugToggle = document.getElementById('debug-logging');
    debugToggle.checked = defaults.debugLogging === true;

    const htmlToggle = document.getElementById('html-to-markdown');
    htmlToggle.checked = defaults.htmlToMarkdown === true;

    const stripUrlToggle = document.getElementById('strip-url-params');
    stripUrlToggle.checked = defaults.stripUrlParams === true;

    const altTextToggle = document.getElementById('alt-text-images');
    altTextToggle.checked = defaults.altTextImages === true;

    const collapseWhitespaceToggle = document.getElementById('collapse-whitespace');
    collapseWhitespaceToggle.checked = defaults.collapseWhitespace === true;

    const tokenReductionToggle = document.getElementById('token-reduction');
    tokenReductionToggle.checked = defaults.tokenReduction === true;

    function tokenSavingEnabled() {
        return htmlToggle.checked
            || stripUrlToggle.checked
            || altTextToggle.checked
            || collapseWhitespaceToggle.checked
            || tokenReductionToggle.checked;
    }

    function updatePromptReductionLabel(hasDiff) {
        if (!promptReductionLabel) return;
        if (!hasDiff || !tokenSavingEnabled() || !lastFullText || !lastPromptText) {
            promptReductionLabel.classList.add('is-hidden');
            return;
        }
        const baseLength = lastFullText.length;
        const promptLength = lastPromptText.length;
        const percentSaved = baseLength > 0
            ? Math.max(0, Math.round((1 - (promptLength / baseLength)) * 100))
            : 0;
        promptReductionLabel.textContent = `Prompt Token Reduction: ${percentSaved}%`;
        promptReductionLabel.classList.remove('is-hidden');
    }

    function updateDiffDisplay() {
        if (lastFullText && lastPromptText && diff_match_patch) {
            const dmp = new diff_match_patch();
            dmp.Diff_EditCost = 4;
            const diffs = dmp.diff_main(lastFullText, lastPromptText);
            dmp.diff_cleanupEfficiency(diffs);
            const hasDiff = diffs.some(d => d[0] !== 0);
            if (hasDiff) {
                diffDisplay.innerHTML = dmp.diff_prettyHtml(diffs);
                diffContainer.classList.remove('is-hidden');
            } else {
                diffDisplay.innerHTML = '';
                diffContainer.classList.add('is-hidden');
            }
            updatePromptReductionLabel(hasDiff);
        } else {
            diffDisplay.innerHTML = '';
            diffContainer.classList.add('is-hidden');
            updatePromptReductionLabel(false);
        }
    }

    const debugTabToggle = document.getElementById('show-debug-tab');
    const debugTabBtn = document.getElementById('debug-tab-button');
    const errorTabBtn = document.getElementById('errors-tab-button');
    const errorsEmpty = document.getElementById('errors-empty');
    const errorsPanel = document.getElementById('errors-panel');
    const errorsList = document.getElementById('errors-list');
    const errorsCount = document.getElementById('errors-count');
    function updateDebugTab() {
        const visible = debugTabToggle.checked;
        debugTabBtn.classList.toggle('is-hidden', !visible);
    }
    debugTabToggle.checked = defaults.showDebugTab === true;
    debugTabToggle.addEventListener('change', () => { updateDebugTab(); markDirty(); });
    updateDebugTab();

    function formatErrorTime(value) {
        try {
            return new Date(value).toLocaleString();
        } catch (e) {
            return '';
        }
    }

    function renderErrors(entries = []) {
        const hasErrors = entries.length > 0;
        errorTabBtn.classList.toggle('is-hidden', !hasErrors);
        errorsEmpty.classList.toggle('is-hidden', hasErrors);
        errorsPanel.classList.toggle('is-hidden', !hasErrors);
        errorsList.innerHTML = '';
        errorsCount.textContent = String(entries.length);
        if (!hasErrors) {
            return;
        }
        entries.forEach(entry => {
            const card = document.createElement('article');
            card.className = 'message is-danger is-light mb-4';
            const header = document.createElement('div');
            header.className = 'message-header';
            const title = document.createElement('p');
            title.textContent = entry.context || 'Error';
            const time = document.createElement('span');
            time.className = 'is-size-7 has-text-weight-normal';
            time.textContent = formatErrorTime(entry.time);
            header.appendChild(title);
            header.appendChild(time);
            const body = document.createElement('div');
            body.className = 'message-body';
            const summary = document.createElement('p');
            summary.className = 'mb-2';
            summary.textContent = entry.message || 'Unknown error';
            body.appendChild(summary);
            if (entry.detail) {
                const detail = document.createElement('pre');
                detail.className = 'is-family-monospace is-size-7';
                detail.textContent = entry.detail;
                body.appendChild(detail);
            }
            card.appendChild(header);
            card.appendChild(body);
            errorsList.appendChild(card);
        });
    }

    async function loadErrors() {
        try {
            const response = await browser.runtime.sendMessage({ type: 'sortana:getErrorLog' });
            renderErrors(response?.errors || []);
        } catch (e) {
            renderErrors([]);
        }
    }

    browser.runtime.onMessage.addListener((msg) => {
        if (msg?.type === 'sortana:errorLogUpdated') {
            loadErrors();
        }
    });

    await loadErrors();

    updateDiffDisplay();

    [htmlToggle, stripUrlToggle, altTextToggle, collapseWhitespaceToggle, tokenReductionToggle].forEach(toggle => {
        toggle.addEventListener('change', () => {
            updatePromptReductionLabel(!diffContainer.classList.contains('is-hidden'));
        });
    });


    const aiParams = Object.assign({}, DEFAULT_AI_PARAMS, defaults.aiParams || {});
    for (const [key, val] of Object.entries(aiParams)) {
        const el = document.getElementById(key);
        if (el) el.value = val;
    }

    let tagList = [];
    let folderList = [];
    let accountList = [];
    try {
        tagList = await messenger.messages.tags.list();
    } catch (e) {
        logger.aiLog('failed to list tags', {level:'error'}, e);
    }
    try {
        const accounts = await messenger.accounts.list(true);
        accountList = accounts.map(a => ({ id: a.id, name: a.name }));
        const collect = (f, prefix='') => {
            folderList.push({ id: f.id ?? f.path, name: prefix + f.name });
            (f.subFolders || []).forEach(sf => collect(sf, prefix + f.name + '/'));
        };
        for (const acct of accounts) {
            (acct.folders || []).forEach(f => collect(f, `${acct.name}/`));
        }
    } catch (e) {
        logger.aiLog('failed to list folders', {level:'error'}, e);
    }

    const DEFAULT_SYSTEM = 'Determine whether the email satisfies the user\'s criterion.';
    const systemBox = document.getElementById('system-instructions');
    systemBox.value = defaults.customSystemPrompt || DEFAULT_SYSTEM;
    document.getElementById('reset-system').addEventListener('click', () => {
        systemBox.value = DEFAULT_SYSTEM;
    });

    const rulesContainer = document.getElementById('rules-container');
    const addRuleBtn = document.getElementById('add-rule');

    const ruleCountEl = document.getElementById('rule-count');
    const cacheCountEl = document.getElementById('cache-count');
    const queueCountEl = document.getElementById('queue-count');
    const currentTimeEl = document.getElementById('current-time');
    const lastTimeEl = document.getElementById('last-time');
    const averageTimeEl = document.getElementById('average-time');
    const totalTimeEl = document.getElementById('total-time');
    const perHourEl = document.getElementById('per-hour');
    const perDayEl = document.getElementById('per-day');
    let timingLogged = false;
    ruleCountEl.textContent = (defaults.aiRules || []).length;
    cacheCountEl.textContent = defaults.aiCache ? Object.keys(defaults.aiCache).length : 0;

    function createActionRow(action = {type: 'tag'}) {
        const row = document.createElement('div');
        row.className = 'action-row field is-grouped mb-2';

        const typeWrapper = document.createElement('div');
        typeWrapper.className = 'select is-small mr-2';
        const typeSelect = document.createElement('select');
        ['tag','move','copy','junk','read','flag','delete','archive','forward','reply'].forEach(t => {
            const opt = document.createElement('option');
            opt.value = t;
            opt.textContent = t;
            typeSelect.appendChild(opt);
        });
        typeSelect.value = action.type;
        typeWrapper.appendChild(typeSelect);

        const paramSpan = document.createElement('span');

        function updateParams() {
            paramSpan.innerHTML = '';
            if (typeSelect.value === 'tag') {
                const wrap = document.createElement('div');
                wrap.className = 'select is-small';
                const sel = document.createElement('select');
                sel.className = 'tag-select';
                for (const t of tagList) {
                    const opt = document.createElement('option');
                    opt.value = t.key;
                    opt.textContent = t.tag;
                    sel.appendChild(opt);
                }
                sel.value = action.tagKey || '';
                wrap.appendChild(sel);
                paramSpan.appendChild(wrap);
            } else if (typeSelect.value === 'move' || typeSelect.value === 'copy') {
                const wrap = document.createElement('div');
                wrap.className = 'select is-small';
                const sel = document.createElement('select');
                sel.className = 'folder-select';
                for (const f of folderList) {
                    const opt = document.createElement('option');
                    opt.value = f.id;
                    opt.textContent = f.name;
                    sel.appendChild(opt);
                }
                sel.value = action.folder || action.copyTarget || '';
                wrap.appendChild(sel);
                paramSpan.appendChild(wrap);
            } else if (typeSelect.value === 'junk') {
                const wrap = document.createElement('div');
                wrap.className = 'select is-small';
                const sel = document.createElement('select');
                sel.className = 'junk-select';
                sel.appendChild(new Option('mark junk','true'));
                sel.appendChild(new Option('mark not junk','false'));
                sel.value = String(action.junk ?? true);
                wrap.appendChild(sel);
                paramSpan.appendChild(wrap);
            } else if (typeSelect.value === 'read') {
                const wrap = document.createElement('div');
                wrap.className = 'select is-small';
                const sel = document.createElement('select');
                sel.className = 'read-select';
                sel.appendChild(new Option('mark read','true'));
                sel.appendChild(new Option('mark unread','false'));
                sel.value = String(action.read ?? true);
                wrap.appendChild(sel);
                paramSpan.appendChild(wrap);
            } else if (typeSelect.value === 'flag') {
                const wrap = document.createElement('div');
                wrap.className = 'select is-small';
                const sel = document.createElement('select');
                sel.className = 'flag-select';
                sel.appendChild(new Option('flag','true'));
                sel.appendChild(new Option('unflag','false'));
                sel.value = String(action.flagged ?? true);
                wrap.appendChild(sel);
                paramSpan.appendChild(wrap);
            } else if (typeSelect.value === 'forward') {
                const input = document.createElement('input');
                input.type = 'text';
                input.className = 'input is-small forward-input';
                input.placeholder = 'address@example.com';
                input.value = action.address || '';
                paramSpan.appendChild(input);
            } else if (typeSelect.value === 'reply') {
                const wrap = document.createElement('div');
                wrap.className = 'select is-small';
                const sel = document.createElement('select');
                sel.className = 'reply-select';
                sel.appendChild(new Option('all','all'));
                sel.appendChild(new Option('sender','sender'));
                sel.value = action.replyType || 'all';
                wrap.appendChild(sel);
                paramSpan.appendChild(wrap);
            } else if (typeSelect.value === 'delete' || typeSelect.value === 'archive') {
                paramSpan.appendChild(document.createElement('span'));
            }
        }

        typeSelect.addEventListener('change', updateParams);
        updateParams();

        const removeBtn = document.createElement('button');
        removeBtn.textContent = 'Remove';
        removeBtn.type = 'button';
        removeBtn.className = 'button is-small is-danger is-light';
        removeBtn.addEventListener('click', () => row.remove());

        row.appendChild(typeWrapper);
        row.appendChild(paramSpan);
        row.appendChild(removeBtn);

        return row;
    }

    function createConditionButton(label, sectionEl, checkbox, clearFn) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'button is-small is-light';
        const icon = document.createElement('img');
        icon.width = 16;
        icon.height = 16;
        icon.className = 'mr-1';
        btn.appendChild(icon);
        btn.append(label);

        let active = checkbox ? checkbox.checked : sectionEl && !sectionEl.classList.contains('is-hidden');

        function update() {
            btn.classList.toggle('is-active', active);
            icon.src = browser.runtime.getURL(`resources/svg/${active ? 'circledot' : 'circle'}.svg`);
            if (sectionEl) sectionEl.classList.toggle('is-hidden', !active);
            if (checkbox) checkbox.checked = active;
            if (!active && typeof clearFn === 'function') {
                clearFn();
            }
        }

        btn.addEventListener('click', () => {
            active = !active;
            markDirty();
            update();
        });

        update();
        return btn;
    }

    function renderRules(rules = []) {
        ruleCountEl.textContent = rules.length;
        rulesContainer.innerHTML = '';
        for (const rule of rules) {
            const article = document.createElement('article');
            article.className = 'rule message mb-4';
            article.draggable = true;
            article.addEventListener('dragstart', ev => { dragRule = article; ev.dataTransfer.setData('text/plain', ''); });
            article.addEventListener('dragover', ev => ev.preventDefault());
            article.addEventListener('drop', ev => {
                ev.preventDefault();
                if (dragRule && dragRule !== article) {
                    const children = Array.from(rulesContainer.children);
                    const dragIndex = children.indexOf(dragRule);
                    const dropIndex = children.indexOf(article);
                    if (dragIndex < dropIndex) {
                        rulesContainer.insertBefore(dragRule, article.nextSibling);
                    } else {
                        rulesContainer.insertBefore(dragRule, article);
                    }
                    markDirty();
                }
            });

            const critInput = document.createElement('input');
            critInput.type = 'text';
            critInput.placeholder = 'Criterion';
            critInput.value = rule.criterion || '';
            critInput.className = 'input criterion mr-2';
            critInput.style.flexGrow = '1';

            const header = document.createElement('div');
            header.className = 'message-header';

            const leftWrap = document.createElement('div');
            leftWrap.style.display = 'flex';
            leftWrap.style.alignItems = 'center';
            leftWrap.style.flexGrow = '1';

            const statusSpan = document.createElement('span');
            statusSpan.className = 'rule-status has-text-weight-semibold mr-2';

            leftWrap.appendChild(statusSpan);
            leftWrap.appendChild(critInput);
            header.appendChild(leftWrap);

            const btnWrap = document.createElement('div');
            btnWrap.style.display = 'flex';
            btnWrap.style.gap = '0.25em';

            let enabled = rule.enabled !== false;

            const toggleBtn = document.createElement('button');
            toggleBtn.type = 'button';
            toggleBtn.className = 'button is-small is-light rule-toggle';
            const toggleIcon = document.createElement('img');
            toggleIcon.width = 16;
            toggleIcon.height = 16;
            toggleBtn.appendChild(toggleIcon);

            const delBtn = document.createElement('button');
            delBtn.type = 'button';
            delBtn.className = 'button is-small is-danger is-light rule-delete';
            const delIcon = document.createElement('img');
            delIcon.src = browser.runtime.getURL('resources/svg/trash.svg');
            delIcon.width = 16;
            delIcon.height = 16;
            delBtn.appendChild(delIcon);

            function updateToggle() {
                toggleIcon.src = browser.runtime.getURL(
                    `resources/svg/${enabled ? 'circleslash' : 'check'}.svg`
                );
                statusSpan.textContent = enabled ? '' : '(Disabled)';
                article.dataset.enabled = String(enabled);
            }

            toggleBtn.addEventListener('click', () => {
                enabled = !enabled;
                markDirty();
                updateToggle();
            });

            delBtn.addEventListener('click', () => {
                article.remove();
                ruleCountEl.textContent = rulesContainer.querySelectorAll('.rule').length;
                markDirty();
            });

            btnWrap.appendChild(toggleBtn);
            btnWrap.appendChild(delBtn);
            header.appendChild(btnWrap);

            updateToggle();

            const actionsContainer = document.createElement('div');
            actionsContainer.className = 'rule-actions mb-2';

            for (const act of (rule.actions || [])) {
                actionsContainer.appendChild(createActionRow(act));
            }

            const addAction = document.createElement('button');
            addAction.textContent = 'Add Action';
            addAction.type = 'button';
            addAction.className = 'button is-small mb-2';
            addAction.addEventListener('click', () => actionsContainer.appendChild(createActionRow()));

           const stopLabel = document.createElement('label');
           stopLabel.className = 'checkbox mt-2 is-hidden';
           const stopCheck = document.createElement('input');
           stopCheck.type = 'checkbox';
           stopCheck.className = 'stop-processing';
           stopCheck.checked = rule.stopProcessing === true;
           stopLabel.appendChild(stopCheck);
           stopLabel.append(' Stop after match');

            const unreadLabel = document.createElement('label');
            unreadLabel.className = 'checkbox mt-2 ml-4 is-hidden';
            const unreadCheck = document.createElement('input');
            unreadCheck.type = 'checkbox';
            unreadCheck.className = 'unread-only';
            unreadCheck.checked = rule.unreadOnly === true;
            unreadLabel.appendChild(unreadCheck);
            unreadLabel.append(' Only apply to unread messages');

            const ageBox = document.createElement('div');
            ageBox.className = 'field is-grouped mt-2 is-hidden';
            const minInput = document.createElement('input');
            minInput.type = 'number';
            minInput.placeholder = 'Min days';
            minInput.className = 'input is-small min-age mr-2';
            minInput.style.width = '6em';
            if (typeof rule.minAgeDays === 'number') minInput.value = rule.minAgeDays;
            const maxInput = document.createElement('input');
            maxInput.type = 'number';
            maxInput.placeholder = 'Max days';
            maxInput.className = 'input is-small max-age';
            maxInput.style.width = '6em';
            if (typeof rule.maxAgeDays === 'number') maxInput.value = rule.maxAgeDays;
            ageBox.appendChild(minInput);
            ageBox.appendChild(maxInput);

            const acctBox = document.createElement('div');
            acctBox.className = 'field mt-2 is-hidden';
            const acctLabel = document.createElement('label');
            acctLabel.className = 'label';
            acctLabel.textContent = 'Accounts';
            const acctControl = document.createElement('div');
            const acctWrap = document.createElement('div');
            acctWrap.className = 'select is-multiple is-small';
            const acctSel = document.createElement('select');
            acctSel.className = 'account-select';
            acctSel.multiple = true;
            acctSel.size = Math.min(accountList.length, 4) || 1;
            for (const a of accountList) {
                const opt = document.createElement('option');
                opt.value = a.id;
                opt.textContent = a.name;
                if ((rule.accounts || []).includes(a.id)) opt.selected = true;
                acctSel.appendChild(opt);
            }
            acctWrap.appendChild(acctSel);
            acctControl.appendChild(acctWrap);
            acctBox.appendChild(acctLabel);
            acctBox.appendChild(acctControl);

            const folderBox = document.createElement('div');
            folderBox.className = 'field mt-2 is-hidden';
            const folderLabel = document.createElement('label');
            folderLabel.className = 'label';
            folderLabel.textContent = 'Folders';
            const folderControl = document.createElement('div');
            const folderWrap = document.createElement('div');
            folderWrap.className = 'select is-multiple is-small';
            const folderSel = document.createElement('select');
            folderSel.className = 'folder-filter-select';
            folderSel.multiple = true;
            folderSel.size = Math.min(folderList.length, 6) || 1;
            for (const f of folderList) {
                const opt = document.createElement('option');
                opt.value = f.id;
                opt.textContent = f.name;
                if ((rule.folders || []).includes(f.id)) opt.selected = true;
                folderSel.appendChild(opt);
            }
            folderWrap.appendChild(folderSel);
            folderControl.appendChild(folderWrap);
            folderBox.appendChild(folderLabel);
            folderBox.appendChild(folderControl);

            if (typeof rule.minAgeDays === 'number' || typeof rule.maxAgeDays === 'number') {
                ageBox.classList.remove('is-hidden');
            }
            if ((rule.accounts || []).length) {
                acctBox.classList.remove('is-hidden');
            }
            if ((rule.folders || []).length) {
                folderBox.classList.remove('is-hidden');
            }

            const condButtons = document.createElement('div');
            condButtons.className = 'field is-grouped is-grouped-multiline mb-2';

            function addCond(btn) {
                const p = document.createElement('p');
                p.className = 'control';
                p.appendChild(btn);
                condButtons.appendChild(p);
            }

            addCond(createConditionButton('Stop', null, stopCheck, () => {
                stopCheck.checked = false;
            }));
            addCond(createConditionButton('Unread', null, unreadCheck, () => {
                unreadCheck.checked = false;
            }));
            addCond(createConditionButton('Age', ageBox, null, () => {
                minInput.value = '';
                maxInput.value = '';
            }));
            addCond(createConditionButton('Accounts', acctBox, null, () => {
                for (const opt of acctSel.options) opt.selected = false;
            }));
            addCond(createConditionButton('Folders', folderBox, null, () => {
                for (const opt of folderSel.options) opt.selected = false;
            }));

            const body = document.createElement('div');
            body.className = 'message-body';
            body.appendChild(actionsContainer);
            body.appendChild(addAction);
            const condDivider = document.createElement('hr');
            condDivider.className = 'mt-3 mb-2';
            body.appendChild(condDivider);
            body.appendChild(condButtons);
            body.appendChild(stopLabel);
            body.appendChild(unreadLabel);
            body.appendChild(ageBox);
            body.appendChild(acctBox);
            body.appendChild(folderBox);

            article.appendChild(header);
            article.appendChild(body);

            rulesContainer.appendChild(article);
        }
    }

    addRuleBtn.addEventListener('click', () => {
        const data = [...rulesContainer.querySelectorAll('.rule')].map(ruleEl => {
            const criterion = ruleEl.querySelector('.criterion').value;
            const actions = [...ruleEl.querySelectorAll('.action-row')].map(row => {
                const type = row.querySelector('select').value;
                if (type === 'tag') {
                    return { type, tagKey: row.querySelector('.tag-select').value };
                }
                if (type === 'move') {
                    return { type, folder: row.querySelector('.folder-select').value };
                }
                if (type === 'copy') {
                    return { type, copyTarget: row.querySelector('.folder-select').value };
                }
                if (type === 'junk') {
                    return { type, junk: row.querySelector('.junk-select').value === 'true' };
                }
                if (type === 'read') {
                    return { type, read: row.querySelector('.read-select').value === 'true' };
                }
                if (type === 'flag') {
                    return { type, flagged: row.querySelector('.flag-select').value === 'true' };
                }
                if (type === 'delete' || type === 'archive') {
                    return { type };
                }
                return { type };
            });
            const stopProcessing = ruleEl.querySelector('.stop-processing')?.checked;
            const unreadOnly = ruleEl.querySelector('.unread-only')?.checked;
            const enabled = ruleEl.dataset.enabled !== 'false';
            const minAgeDays = parseFloat(ruleEl.querySelector('.min-age')?.value);
            const maxAgeDays = parseFloat(ruleEl.querySelector('.max-age')?.value);
            const accounts = [...(ruleEl.querySelector('.account-select')?.selectedOptions || [])].map(o => o.value);
            const folders = [...(ruleEl.querySelector('.folder-filter-select')?.selectedOptions || [])].map(o => o.value);
            const rule = { criterion, actions, enabled };
            if (unreadOnly) rule.unreadOnly = true;
            if (stopProcessing) rule.stopProcessing = true;
            if (!isNaN(minAgeDays)) rule.minAgeDays = minAgeDays;
            if (!isNaN(maxAgeDays)) rule.maxAgeDays = maxAgeDays;
            if (accounts.length) rule.accounts = accounts;
            if (folders.length) rule.folders = folders;
            return rule;
        });
        data.push({ criterion: '', actions: [], unreadOnly: false, stopProcessing: false, enabled: true, accounts: [], folders: [] });
        renderRules(data);
    });

    renderRules((defaults.aiRules || []).map(r => {
        if (r.actions) {
            if (!Array.isArray(r.accounts)) r.accounts = [];
            if (!Array.isArray(r.folders)) r.folders = [];
            if (r.enabled !== false) r.enabled = true; else r.enabled = false;
            return r;
        }
        const actions = [];
        if (r.tag) actions.push({ type: 'tag', tagKey: r.tag });
        if (r.moveTo) actions.push({ type: 'move', folder: r.moveTo });
        if (r.copyTarget || r.copyTo) actions.push({ type: 'copy', copyTarget: r.copyTarget || r.copyTo });
        const rule = { criterion: r.criterion, actions };
        if (r.stopProcessing) rule.stopProcessing = true;
        if (r.unreadOnly) rule.unreadOnly = true;
        if (typeof r.minAgeDays === 'number') rule.minAgeDays = r.minAgeDays;
        if (typeof r.maxAgeDays === 'number') rule.maxAgeDays = r.maxAgeDays;
        if (Array.isArray(r.accounts)) rule.accounts = r.accounts;
        if (Array.isArray(r.folders)) rule.folders = r.folders;
        rule.enabled = r.enabled !== false;
        return rule;
    }));


    function format(ms) {
        if (ms < 0) return '--:--:--';
        let totalSec = Math.floor(ms / 1000);
        const sec = totalSec % 60;
        totalSec = (totalSec - sec) / 60;
        const min = totalSec % 60;
        const hr = (totalSec - min) / 60;
        return `${String(hr).padStart(2, '0')}:${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
    }

    async function refreshMaintenance() {
        try {
            const stats = await browser.runtime.sendMessage({ type: 'sortana:getTiming' });
            queueCountEl.textContent = stats.count;
            currentTimeEl.classList.remove('has-text-danger');
            lastTimeEl.classList.remove('has-text-success','has-text-danger');
            let arrow = '';
            if (stats.last >= 0) {
                if (stats.stddev > 0 && stats.last - stats.average > stats.stddev) {
                    lastTimeEl.classList.add('has-text-danger');
                    arrow = ' ▲';
                } else if (stats.stddev > 0 && stats.average - stats.last > stats.stddev) {
                    lastTimeEl.classList.add('has-text-success');
                    arrow = ' ▼';
                }
                lastTimeEl.textContent = format(stats.last) + arrow;
            } else {
                lastTimeEl.textContent = '--:--:--';
            }
            if (stats.current >= 0) {
                if (stats.stddev > 0 && stats.current - stats.average > stats.stddev) {
                    currentTimeEl.classList.add('has-text-danger');
                }
                currentTimeEl.textContent = format(stats.current);
            } else {
                currentTimeEl.textContent = '--:--:--';
            }
            averageTimeEl.textContent = stats.runs > 0 ? format(stats.average) : '--:--:--';
            totalTimeEl.textContent = format(stats.total);
            const perHour = stats.average > 0 ? Math.round(3600000 / stats.average) : 0;
            const perDay = stats.average > 0 ? Math.round(86400000 / stats.average) : 0;
            perHourEl.textContent = perHour;
            perDayEl.textContent = perDay;
            if (!timingLogged) {
                logger.aiLog('retrieved timing stats', {debug: true});
                timingLogged = true;
            }
        } catch (e) {
            queueCountEl.textContent = '?';
            currentTimeEl.textContent = '--:--:--';
            lastTimeEl.textContent = '--:--:--';
            averageTimeEl.textContent = '--:--:--';
            totalTimeEl.textContent = '--:--:--';
            perHourEl.textContent = '0';
            perDayEl.textContent = '0';
        }

        try {
            const { aiCache } = await storage.local.get('aiCache');
            cacheCountEl.textContent = aiCache ? Object.keys(aiCache).length : 0;
        } catch {
            cacheCountEl.textContent = '?';
        }

        try {
            if (debugTabToggle.checked) {
                const latest = await storage.local.get(['lastPayload', 'lastFullText', 'lastPromptText']);
                const payloadStr = latest.lastPayload ? JSON.stringify(latest.lastPayload, null, 2) : '';
                if (payloadStr !== lastPayload) {
                    lastPayload = payloadStr;
                    payloadDisplay.textContent = payloadStr;
                }
                if (latest.lastFullText !== lastFullText || latest.lastPromptText !== lastPromptText) {
                    lastFullText = latest.lastFullText || '';
                    lastPromptText = latest.lastPromptText || '';
                    updateDiffDisplay();
                }
            }
        } catch {}
    }

    refreshMaintenance();
    setInterval(refreshMaintenance, 1000);

    document.getElementById('clear-cache').addEventListener('click', async () => {
        await AiClassifier.clearCache();
        cacheCountEl.textContent = '0';
    });

    function selectedCategories() {
        return [...document.querySelectorAll('.transfer-category:checked')].map(el => el.value);
    }

    document.getElementById('export-data').addEventListener('click', () => {
        dataTransfer.exportData(selectedCategories());
    });

    const importInput = document.getElementById('import-file');
    document.getElementById('import-data').addEventListener('click', () => importInput.click());
    importInput.addEventListener('change', async () => {
        if (importInput.files.length) {
            await dataTransfer.importData(importInput.files[0], selectedCategories());
            location.reload();
        }
    });

    initialized = true;

    document.getElementById('save').addEventListener('click', async () => {
        const endpoint = endpointInput.value.trim();
        const templateName = templateSelect.value;
        const customTemplateText = customTemplate.value;
        const customSystemPrompt = systemBox.value;
        const aiParamsSave = {};
        for (const key of Object.keys(DEFAULT_AI_PARAMS)) {
            const el = document.getElementById(key);
            if (el) {
                const num = parseFloat(el.value);
                aiParamsSave[key] = isNaN(num) ? DEFAULT_AI_PARAMS[key] : num;
            }
        }
        const debugLogging = debugToggle.checked;
        const htmlToMarkdown = htmlToggle.checked;
        const rules = [...rulesContainer.querySelectorAll('.rule')].map(ruleEl => {
            const criterion = ruleEl.querySelector('.criterion').value;
            const actions = [...ruleEl.querySelectorAll('.action-row')].map(row => {
                const type = row.querySelector('select').value;
                if (type === 'tag') {
                    return { type, tagKey: row.querySelector('.tag-select').value };
                }
                if (type === 'move') {
                    return { type, folder: row.querySelector('.folder-select').value };
                }
                if (type === 'copy') {
                    return { type, copyTarget: row.querySelector('.folder-select').value };
                }
                if (type === 'junk') {
                    return { type, junk: row.querySelector('.junk-select').value === 'true' };
                }
                if (type === 'read') {
                    return { type, read: row.querySelector('.read-select').value === 'true' };
                }
                if (type === 'flag') {
                    return { type, flagged: row.querySelector('.flag-select').value === 'true' };
                }
                if (type === 'forward') {
                    return { type, address: row.querySelector('.forward-input').value.trim() };
                }
                if (type === 'reply') {
                    return { type, replyType: row.querySelector('.reply-select').value };
                }
                return { type };
            });
            const stopProcessing = ruleEl.querySelector('.stop-processing')?.checked;
            const unreadOnly = ruleEl.querySelector('.unread-only')?.checked;
            const enabled = ruleEl.dataset.enabled !== 'false';
            const minAgeDays = parseFloat(ruleEl.querySelector('.min-age')?.value);
            const maxAgeDays = parseFloat(ruleEl.querySelector('.max-age')?.value);
            const accounts = [...(ruleEl.querySelector('.account-select')?.selectedOptions || [])].map(o => o.value);
            const folders = [...(ruleEl.querySelector('.folder-filter-select')?.selectedOptions || [])].map(o => o.value);
            const rule = { criterion, actions, enabled };
            if (unreadOnly) rule.unreadOnly = true;
            if (stopProcessing) rule.stopProcessing = true;
            if (!isNaN(minAgeDays)) rule.minAgeDays = minAgeDays;
            if (!isNaN(maxAgeDays)) rule.maxAgeDays = maxAgeDays;
            if (accounts.length) rule.accounts = accounts;
            if (folders.length) rule.folders = folders;
            return rule;
        }).filter(r => r.criterion);
        const stripUrlParams = stripUrlToggle.checked;
        const altTextImages = altTextToggle.checked;
        const collapseWhitespace = collapseWhitespaceToggle.checked;
        const tokenReduction = tokenReductionToggle.checked;
        const showDebugTab = debugTabToggle.checked;
        const theme = themeSelect.value;
        await storage.local.set({ endpoint, templateName, customTemplate: customTemplateText, customSystemPrompt, aiParams: aiParamsSave, debugLogging, htmlToMarkdown, stripUrlParams, altTextImages, collapseWhitespace, tokenReduction, aiRules: rules, theme, showDebugTab });
        await applyTheme(theme);
        try {
            await AiClassifier.setConfig({ endpoint, templateName, customTemplate: customTemplateText, customSystemPrompt, aiParams: aiParamsSave, debugLogging });
            logger.setDebug(debugLogging);
        } catch (e) {
            logger.aiLog('[options] failed to apply config', {level: 'error'}, e);
        }
        saveBtn.disabled = true;
    });
});
