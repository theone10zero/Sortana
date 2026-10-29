document.addEventListener('DOMContentLoaded', async () => {
    const storage = (globalThis.messenger ?? browser).storage;
    const logger = await import(browser.runtime.getURL('logger.js'));
    const AiClassifier = await import(browser.runtime.getURL('modules/AiClassifier.js'));
    const dataTransfer = await import(browser.runtime.getURL('options/dataTransfer.js'));
    const { detectSystemTheme } = await import(browser.runtime.getURL('modules/themeUtils.js'));
    const { DEFAULT_AI_PARAMS } = await import(browser.runtime.getURL('modules/defaultParams.js'));
    const { validateSettings, migratedInputLimit, CONFIG_DEFAULTS } = await import(browser.runtime.getURL('modules/classificationConfig.js'));
    const chatCompletions = await import(browser.runtime.getURL('modules/backends/chatCompletions.js'));
    const promptLanguage = await import(browser.runtime.getURL('modules/promptLanguage.js'));
    const { t, applyToDocument, currentLocale } = await import(browser.runtime.getURL('modules/i18n.js'));
    document.documentElement.lang = currentLocale();
    applyToDocument(document);
    const defaults = await storage.local.get([
        'systemOneProcessAll', 'systemOneBatchSize',
        'apiType', 'decisionThreshold', 'inputCharacterLimit',
        'endpoint',
        'customSystemPrompt',
        'promptLanguage',
        'model',
        'apiKey',
        'openaiOrganization',
        'openaiProject',
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
    const apiTypeInput = document.getElementById('api-type');
    apiTypeInput.value = defaults.apiType || 'chat-completions';
    const processAllInput = document.getElementById('systemone-process-all');
    const batchSizeInput = document.getElementById('systemone-batch-size');
    processAllInput.checked = defaults.systemOneProcessAll ?? true;
    let savedBatchSize = defaults.systemOneBatchSize ?? 8;
    batchSizeInput.value = savedBatchSize;
    function updateBatchControls() {
        batchSizeInput.disabled = processAllInput.checked || apiTypeInput.value !== 'systemone';
    }
    processAllInput.addEventListener('change', updateBatchControls);
    const thresholdInput = document.getElementById('decision-threshold');
    thresholdInput.value = (defaults.decisionThreshold ?? 0.5) * 100;
    const inputLimit = document.getElementById('input-character-limit');
    inputLimit.value = migratedInputLimit(defaults);
    const inputLimitEstimate = document.getElementById('input-char-limit-estimate');
    function updateInputLimitEstimate() {
        const limit = Number(inputLimit.value);
        if (!Number.isFinite(limit) || limit <= 0) {
            inputLimitEstimate.textContent = '';
            return;
        }
        // Latin text averages ~4 characters per token, Chinese ~1 character per
        // token, so the same character limit buys a very different token budget.
        inputLimitEstimate.textContent = t('adv.inputCharLimitEstimate', {
            LATIN: Math.round(limit / 4),
            HAN: Math.round(limit)
        });
    }
    inputLimit.addEventListener('input', updateInputLimitEstimate);
    updateInputLimitEstimate();
    const promptLanguageSelect = document.getElementById('prompt-language');
    promptLanguageSelect.value = ['auto', 'zh-CN', 'en'].includes(defaults.promptLanguage)
        ? defaults.promptLanguage
        : 'auto';
    const settingsError = document.getElementById('settings-error');
    function updateApiControls() {
        const decision = apiTypeInput.value === 'systemone';
        updateBatchControls();
        document.querySelectorAll('.systemone-only').forEach(el => el.classList.toggle('is-hidden', !decision));
        for (const id of ['system-instructions', 'openai-organization', 'openai-project', ...Object.keys(DEFAULT_AI_PARAMS)]) {
            document.getElementById(id)?.closest('.field')?.classList.toggle('is-hidden', decision);
        }
        document.getElementById('reset-system').classList.toggle('is-hidden', decision);
        document.getElementById('reset-system-prompt').classList.toggle('is-hidden', decision);
        updateEndpointPreview();
    }
    apiTypeInput.addEventListener('change', updateApiControls);
    const endpointInput = document.getElementById('endpoint');
    const endpointPreview = document.getElementById('endpoint-preview');
    const fallbackEndpoint = 'http://127.0.0.1:5000';
    const storedEndpoint = defaults.endpoint || fallbackEndpoint;
    const endpointBase = AiClassifier.normalizeEndpointBase(storedEndpoint) || storedEndpoint;
    endpointInput.value = endpointBase;

    function updateEndpointPreview() {
        const resolved = AiClassifier.buildEndpointUrl(endpointInput.value, apiTypeInput.value);
        endpointPreview.textContent = resolved
            ? t('settings.endpointResolved', { URL: resolved })
            : t('settings.endpointInvalid');
    }
    endpointInput.addEventListener('input', updateEndpointPreview);
    updateApiControls();

    const modelSelect = document.getElementById('model-select');
    const refreshModelsBtn = document.getElementById('refresh-models');
    const modelHelp = document.getElementById('model-help');
    const storedModel = typeof defaults.model === 'string' ? defaults.model : '';

    function setModelHelp(message = '', isError = false) {
        if (!modelHelp) return;
        modelHelp.textContent = message;
        modelHelp.classList.toggle('is-danger', isError);
    }

    function populateModelOptions(models = [], selectedModel = '') {
        if (!modelSelect) return;
        const modelIds = Array.isArray(models) ? models.filter(Boolean) : [];
        modelSelect.innerHTML = '';

        const noneOpt = document.createElement('option');
        noneOpt.value = '';
        noneOpt.textContent = t('settings.modelNone');
        modelSelect.appendChild(noneOpt);

        if (selectedModel && !modelIds.includes(selectedModel)) {
            const storedOpt = document.createElement('option');
            storedOpt.value = selectedModel;
            storedOpt.textContent = t('settings.modelStored', { MODEL: selectedModel });
            modelSelect.appendChild(storedOpt);
        }

        for (const id of modelIds) {
            const opt = document.createElement('option');
            opt.value = id;
            opt.textContent = id;
            modelSelect.appendChild(opt);
        }

        const hasSelected = [...modelSelect.options].some(opt => opt.value === selectedModel);
        modelSelect.value = hasSelected ? selectedModel : '';
    }

    function buildAuthHeaders() {
        const headers = {};
        const apiKey = apiKeyInput?.value.trim();
        if (apiKey) {
            headers.Authorization = `Bearer ${apiKey}`;
        }
        const organization = openaiOrgInput?.value.trim();
        if (organization && apiTypeInput.value === 'chat-completions') {
            headers["OpenAI-Organization"] = organization;
        }
        const project = openaiProjectInput?.value.trim();
        if (project && apiTypeInput.value === 'chat-completions') {
            headers["OpenAI-Project"] = project;
        }
        return headers;
    }

    async function fetchModels(preferredModel = '') {
        if (!modelSelect || !refreshModelsBtn) return;
        const modelsUrl = AiClassifier.buildModelsUrl(endpointInput.value);
        const selectedModel = preferredModel || modelSelect.value;
        if (!modelsUrl) {
            logger.aiLog('[options] model refresh skipped: invalid endpoint', { level: 'warn' }, {
                endpoint: endpointInput.value
            });
            setModelHelp(t('settings.modelInvalid'), true);
            populateModelOptions([], selectedModel);
            return;
        }

        refreshModelsBtn.disabled = true;
        setModelHelp(t('settings.modelLoading'));
        const headers = buildAuthHeaders();
        logger.aiLog('[options] loading models', {}, {
            endpoint: endpointInput.value,
            modelsUrl,
            selectedModel,
            hasAuthorization: typeof headers.Authorization === 'string',
            hasOrganization: typeof headers['OpenAI-Organization'] === 'string',
            hasProject: typeof headers['OpenAI-Project'] === 'string'
        });

        try {
            const response = await fetch(modelsUrl, { method: 'GET', headers });
            logger.aiLog('[options] model refresh response received', {}, {
                status: response.status,
                ok: response.ok,
                contentType: response.headers.get('content-type') || ''
            });
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }
            const data = await response.json();
            logger.aiLog('[options] model refresh payload parsed', {}, {
                payloadType: Array.isArray(data) ? 'array' : typeof data,
                hasDataArray: Array.isArray(data?.data),
                hasModelsArray: Array.isArray(data?.models),
                topLevelKeys: data && typeof data === 'object' && !Array.isArray(data)
                    ? Object.keys(data)
                    : []
            });
            let models = [];
            if (Array.isArray(data?.data)) {
                models = data.data.map(model => model?.id ?? model?.name ?? model?.model ?? '').filter(Boolean);
            } else if (Array.isArray(data?.models)) {
                models = data.models.map(model => model?.id ?? model?.name ?? model?.model ?? '').filter(Boolean);
            } else if (Array.isArray(data)) {
                models = data.map(model => model?.id ?? model?.name ?? model?.model ?? model).filter(Boolean);
            }
            models = [...new Set(models)];
            logger.aiLog('[options] model refresh parsed models', {}, {
                count: models.length,
                models
            });
            populateModelOptions(models, selectedModel);
            setModelHelp(models.length ? t('settings.modelLoaded', { COUNT: models.length }) : t('settings.modelEmpty'));
        } catch (e) {
            logger.aiLog('[options] failed to load models', { level: 'warn' }, e);
            const message = String(e?.message || e || '');
            const isLikelyCors = e instanceof TypeError || /Failed to fetch|NetworkError|Load failed/i.test(message);
            setModelHelp(
                isLikelyCors
                    ? t('settings.modelCors')
                    : t('settings.modelFailed'),
                true
            );
            populateModelOptions([], selectedModel);
        } finally {
            refreshModelsBtn.disabled = false;
        }
    }

    populateModelOptions([], storedModel);
    refreshModelsBtn?.addEventListener('click', () => {
        logger.aiLog('[options] model refresh button clicked');
        fetchModels(modelSelect.value);
    });

    const advancedBox = document.getElementById('advanced-options');
    const advancedBtn = document.getElementById('toggle-advanced');
    advancedBtn.addEventListener('click', () => {
        advancedBox.classList.toggle('is-hidden');
    });

    const apiKeyInput = document.getElementById('api-key');
    const apiKeyToggle = document.getElementById('toggle-api-key');
    const openaiOrgInput = document.getElementById('openai-organization');
    const openaiProjectInput = document.getElementById('openai-project');
    if (apiKeyInput) {
        apiKeyInput.value = typeof defaults.apiKey === 'string' ? defaults.apiKey : '';
    }
    if (openaiOrgInput) {
        openaiOrgInput.value = typeof defaults.openaiOrganization === 'string' ? defaults.openaiOrganization : '';
    }
    if (openaiProjectInput) {
        openaiProjectInput.value = typeof defaults.openaiProject === 'string' ? defaults.openaiProject : '';
    }
    apiKeyToggle?.addEventListener('click', () => {
        if (!apiKeyInput) return;
        const show = apiKeyInput.type === 'password';
        apiKeyInput.type = show ? 'text' : 'password';
        apiKeyToggle.textContent = show ? t('action.hide') : t('action.show');
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

    function updatePromptReductionLabel(hasDiff) {
        if (!promptReductionLabel) return;
        // The summary is always shorter than the full message, so the label no
        // longer depends on a preprocessing toggle being enabled.
        if (!hasDiff || !lastFullText || !lastPromptText) {
            promptReductionLabel.classList.add('is-hidden');
            return;
        }
        const baseLength = lastFullText.length;
        const promptLength = lastPromptText.length;
        const percentSaved = baseLength > 0
            ? Math.max(0, Math.round((1 - (promptLength / baseLength)) * 100))
            : 0;
        promptReductionLabel.textContent = t('debug.tokenReduction', { PERCENT: percentSaved });
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
            title.textContent = entry.context || t('errors.generic');
            const time = document.createElement('span');
            time.className = 'is-size-7 has-text-weight-normal';
            time.textContent = formatErrorTime(entry.time);
            header.appendChild(title);
            header.appendChild(time);
            const body = document.createElement('div');
            body.className = 'message-body';
            const summary = document.createElement('p');
            summary.className = 'mb-2';
            summary.textContent = entry.message || t('errors.unknown');
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
    await fetchModels(storedModel);

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

    // The system message is one editable template. The options page shows the
    // built-in template, so what the user edits is what the model receives.
    // An empty customSystemPrompt means "use the built-in template", which
    // follows the language of the criterion.
    const systemBox = document.getElementById('system-instructions');
    function defaultSystemPrompt(language) {
        return chatCompletions.getDefaultTemplate(promptLanguage.templateLanguage(language, currentLocale()));
    }
    function isDefaultSystemPrompt(value) {
        return value === defaultSystemPrompt('en') || value === defaultSystemPrompt('zh-CN');
    }
    systemBox.value = defaults.customSystemPrompt || defaultSystemPrompt(defaults.promptLanguage);
    systemBox.addEventListener('input', markDirty);
    document.getElementById('reset-system-prompt').addEventListener('click', () => {
        systemBox.value = defaultSystemPrompt(promptLanguageSelect.value);
        markDirty();
    });
    // Reset every setting to its default. The rules and the cached results
    // belong to the user and are left alone.
    document.getElementById('reset-system').addEventListener('click', async () => {
        await storage.local.set({
            ...CONFIG_DEFAULTS,
            aiParams: { ...DEFAULT_AI_PARAMS },
            theme: 'auto',
            showDebugTab: false
        });
        location.reload();
    });
    promptLanguageSelect.addEventListener('change', () => {
        if (isDefaultSystemPrompt(systemBox.value)) {
            systemBox.value = defaultSystemPrompt(promptLanguageSelect.value);
        }
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
    cacheCountEl.textContent = '…';

    function createActionRow(action = {type: 'tag'}) {
        const row = document.createElement('div');
        row.className = 'action-row field is-grouped mb-2';

        const typeWrapper = document.createElement('div');
        typeWrapper.className = 'select is-small mr-2';
        const typeSelect = document.createElement('select');
        ['tag','move','copy','junk','read','flag','delete','archive','forward','reply'].forEach(type => {
            const opt = document.createElement('option');
            opt.value = type;
            opt.textContent = t(`actionType.${type}`);
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
                sel.appendChild(new Option(t('param.markJunk'),'true'));
                sel.appendChild(new Option(t('param.markNotJunk'),'false'));
                sel.value = String(action.junk ?? true);
                wrap.appendChild(sel);
                paramSpan.appendChild(wrap);
            } else if (typeSelect.value === 'read') {
                const wrap = document.createElement('div');
                wrap.className = 'select is-small';
                const sel = document.createElement('select');
                sel.className = 'read-select';
                sel.appendChild(new Option(t('param.markRead'),'true'));
                sel.appendChild(new Option(t('param.markUnread'),'false'));
                sel.value = String(action.read ?? true);
                wrap.appendChild(sel);
                paramSpan.appendChild(wrap);
            } else if (typeSelect.value === 'flag') {
                const wrap = document.createElement('div');
                wrap.className = 'select is-small';
                const sel = document.createElement('select');
                sel.className = 'flag-select';
                sel.appendChild(new Option(t('param.flag'),'true'));
                sel.appendChild(new Option(t('param.unflag'),'false'));
                sel.value = String(action.flagged ?? true);
                wrap.appendChild(sel);
                paramSpan.appendChild(wrap);
            } else if (typeSelect.value === 'forward') {
                const input = document.createElement('input');
                input.type = 'text';
                input.className = 'input is-small forward-input';
                input.placeholder = 'address@example.com';
                input.setAttribute('aria-label', t('param.address'));
                input.value = action.address || '';
                paramSpan.appendChild(input);
            } else if (typeSelect.value === 'reply') {
                const wrap = document.createElement('div');
                wrap.className = 'select is-small';
                const sel = document.createElement('select');
                sel.className = 'reply-select';
                sel.appendChild(new Option(t('param.replyAll'),'all'));
                sel.appendChild(new Option(t('param.replySender'),'sender'));
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
        removeBtn.textContent = t('action.remove');
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
            critInput.placeholder = t('rules.criterionPlaceholder');
            critInput.setAttribute('aria-label', t('rules.criterion'));
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
                statusSpan.textContent = enabled ? '' : t('rules.disabled');
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
            addAction.textContent = t('action.addAction');
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
           stopLabel.append(' ' + t('rules.stopAfterMatch'));

            const unreadLabel = document.createElement('label');
            unreadLabel.className = 'checkbox mt-2 ml-4 is-hidden';
            const unreadCheck = document.createElement('input');
            unreadCheck.type = 'checkbox';
            unreadCheck.className = 'unread-only';
            unreadCheck.checked = rule.unreadOnly === true;
            unreadLabel.appendChild(unreadCheck);
            unreadLabel.append(' ' + t('rules.unreadOnly'));

            const ageBox = document.createElement('div');
            ageBox.className = 'field is-grouped mt-2 is-hidden';
            const minInput = document.createElement('input');
            minInput.type = 'number';
            minInput.placeholder = t('rules.minDays');
            minInput.className = 'input is-small min-age mr-2';
            minInput.style.width = '6em';
            if (typeof rule.minAgeDays === 'number') minInput.value = rule.minAgeDays;
            const maxInput = document.createElement('input');
            maxInput.type = 'number';
            maxInput.placeholder = t('rules.maxDays');
            maxInput.className = 'input is-small max-age';
            maxInput.style.width = '6em';
            if (typeof rule.maxAgeDays === 'number') maxInput.value = rule.maxAgeDays;
            ageBox.appendChild(minInput);
            ageBox.appendChild(maxInput);

            const acctBox = document.createElement('div');
            acctBox.className = 'field mt-2 is-hidden';
            const acctLabel = document.createElement('label');
            acctLabel.className = 'label';
            acctLabel.textContent = t('rules.accounts');
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
            folderLabel.textContent = t('rules.folders');
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

            addCond(createConditionButton(t('rules.condStop'), null, stopCheck, () => {
                stopCheck.checked = false;
            }));
            addCond(createConditionButton(t('rules.condUnread'), null, unreadCheck, () => {
                unreadCheck.checked = false;
            }));
            addCond(createConditionButton(t('rules.condAge'), ageBox, null, () => {
                minInput.value = '';
                maxInput.value = '';
            }));
            addCond(createConditionButton(t('rules.condAccounts'), acctBox, null, () => {
                for (const opt of acctSel.options) opt.selected = false;
            }));
            addCond(createConditionButton(t('rules.condFolders'), folderBox, null, () => {
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
            const thresholdField = document.createElement('label');
            thresholdField.className = 'field systemone-only';
            thresholdField.classList.toggle('is-hidden', apiTypeInput.value !== 'systemone');
            thresholdField.textContent = t('rules.threshold');
            const override = document.createElement('input');
            override.className = 'input decision-threshold';
            override.type = 'number';
            override.min = '0'; override.max = '100'; override.step = 'any';
            override.value = rule.decisionThreshold === undefined ? '' : rule.decisionThreshold * 100;
            thresholdField.appendChild(override);
            body.appendChild(thresholdField);
            article.appendChild(body);

            rulesContainer.appendChild(article);
        }
    }

    function readRules() {
        return [...rulesContainer.querySelectorAll('.rule')].map(ruleEl => {
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
            const override = ruleEl.querySelector('.decision-threshold').value;
            if (override.trim() !== '') rule.decisionThreshold = Number(override) / 100;
            if (unreadOnly) rule.unreadOnly = true;
            if (stopProcessing) rule.stopProcessing = true;
            if (!isNaN(minAgeDays)) rule.minAgeDays = minAgeDays;
            if (!isNaN(maxAgeDays)) rule.maxAgeDays = maxAgeDays;
            if (accounts.length) rule.accounts = accounts;
            if (folders.length) rule.folders = folders;
            return rule;
        });
    }
    addRuleBtn.addEventListener('click', () => {
        const data = readRules();
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
        if (r.decisionThreshold !== undefined) rule.decisionThreshold = r.decisionThreshold;
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
            const { count } = await browser.runtime.sendMessage({ type: 'sortana:getCacheSize' });
            cacheCountEl.textContent = count;
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

    document.getElementById('reset-timing').addEventListener('click', async () => {
        await browser.runtime.sendMessage({ type: 'sortana:resetTimingStats' });
        await refreshMaintenance();
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
            try {
                await dataTransfer.importData(importInput.files[0], selectedCategories());
                location.reload();
            } catch (error) {
                window.alert(t('error.importFailed', { MESSAGE: error.message }));
            }
        }
    });

    initialized = true;

    document.getElementById('save').addEventListener('click', async () => {
        settingsError.textContent = '';
        const apiType = apiTypeInput.value;
        const systemOneProcessAll = processAllInput.checked;
        const enteredBatchSize = Number(batchSizeInput.value);
        const validBatchSize = Number.isSafeInteger(enteredBatchSize) && enteredBatchSize > 0;
        if (!batchSizeInput.disabled && !validBatchSize) {
            settingsError.textContent = t('error.batchSize');
            return;
        }
        const systemOneBatchSize = validBatchSize ? enteredBatchSize : savedBatchSize;
        const decisionThreshold = thresholdInput.value.trim() === '' ? NaN : Number(thresholdInput.value) / 100;
        const inputCharacterLimit = Number(inputLimit.value);
        const endpoint = endpointInput.value.trim();
        const model = modelSelect?.value || '';
        const apiKey = apiKeyInput?.value.trim() || '';
        const openaiOrganization = openaiOrgInput?.value.trim() || '';
        const openaiProject = openaiProjectInput?.value.trim() || '';
        // An unmodified default is stored as an empty string so the adapter
        // can pick the default for the resolved prompt language. For English
        // that resolves to the same string stored before 4.2.0, so the cache
        // fingerprint is unchanged.
        const customSystemPrompt = isDefaultSystemPrompt(systemBox.value) ? '' : systemBox.value;
        const promptLanguage = promptLanguageSelect.value;
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
        const invalidThreshold = [...document.querySelectorAll('.decision-threshold'), thresholdInput].find(el => !el.checkValidity());
        if (invalidThreshold) {
            settingsError.textContent = t('error.thresholdRange');
            return;
        }
        if (!inputLimit.checkValidity()) {
            settingsError.textContent = t('error.inputLimitRange');
            return;
        }
        const rules = readRules().filter(r => r.criterion);
        const stripUrlParams = stripUrlToggle.checked;
        const altTextImages = altTextToggle.checked;
        const collapseWhitespace = collapseWhitespaceToggle.checked;
        const tokenReduction = tokenReductionToggle.checked;
        const showDebugTab = debugTabToggle.checked;
        const theme = themeSelect.value;
        try { validateSettings({ systemOneProcessAll, systemOneBatchSize, apiType, decisionThreshold, inputCharacterLimit, promptLanguage, aiRules: rules }); }
        catch (error) { settingsError.textContent = error.message; return; }
        await storage.local.set({ systemOneProcessAll, systemOneBatchSize, apiType, decisionThreshold, inputCharacterLimit, endpoint, model, apiKey, openaiOrganization, openaiProject, customSystemPrompt, promptLanguage, aiParams: aiParamsSave, debugLogging, htmlToMarkdown, stripUrlParams, altTextImages, collapseWhitespace, tokenReduction, aiRules: rules, theme, showDebugTab });
        savedBatchSize = systemOneBatchSize;
        batchSizeInput.value = savedBatchSize;
        await storage.local.remove(['templateName', 'customTemplate']);
        await applyTheme(theme);
        try {
            await AiClassifier.setConfig({ systemOneProcessAll, systemOneBatchSize, apiType, decisionThreshold, inputCharacterLimit, endpoint, model, apiKey, openaiOrganization, openaiProject, customSystemPrompt, promptLanguage, aiParams: aiParamsSave, debugLogging, htmlToMarkdown, stripUrlParams, altTextImages, collapseWhitespace, tokenReduction });
            logger.setDebug(debugLogging);
        } catch (e) {
            logger.aiLog('[options] failed to apply config', {level: 'error'}, e);
        }
        saveBtn.disabled = true;
    });
});
