"use strict";
const storage = (globalThis.messenger ?? browser).storage;
const KEY_GROUPS = {
    settings: [
        'endpoint',
        'model',
        'apiKey',
        'openaiOrganization',
        'openaiProject',
        'templateName',
        'customTemplate',
        'customSystemPrompt',
        'aiParams',
        'debugLogging',
        'htmlToMarkdown',
        'stripUrlParams',
        'altTextImages',
        'collapseWhitespace'
    ],
    rules: ['aiRules'],
    cache: ['aiCache']
};

function collectKeys(categories = Object.keys(KEY_GROUPS)) {
    return categories.flatMap(cat => KEY_GROUPS[cat] || []);
}

export async function exportData(categories) {
    const data = await storage.local.get(collectKeys(categories));
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'sortana-export.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
}

export async function importData(file, categories) {
    const text = await file.text();
    const parsed = JSON.parse(text);
    const data = {};
    for (const key of collectKeys(categories)) {
        if (key in parsed) data[key] = parsed[key];
    }
    await storage.local.set(data);
}
