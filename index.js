/**
 * Requesty Connector for SillyTavern
 *
 * Lets SillyTavern talk to the Requesty LLM router (https://requesty.ai) through the
 * built-in "Custom (OpenAI-compatible)" chat completion source, and adds an
 * OpenRouter-style model browser with prices, context sizes and capabilities.
 */

import { eventSource, event_types, getRequestHeaders, main_api, saveSettingsDebounced } from '../../../../script.js';
import { extension_settings, getContext } from '../../../extensions.js';
import { oai_settings } from '../../../openai.js';
import { SECRET_KEYS, secret_state, writeSecret, deleteSecret, rotateSecret, readSecretState } from '../../../secrets.js';
import { yaml } from '../../../../lib.js';
import { SlashCommandParser } from '../../../slash-commands/SlashCommandParser.js';
import { SlashCommand } from '../../../slash-commands/SlashCommand.js';
import { ARGUMENT_TYPE, SlashCommandArgument } from '../../../slash-commands/SlashCommandArgument.js';
import { SlashCommandEnumValue } from '../../../slash-commands/SlashCommandEnumValue.js';

const MODULE = 'requesty';
const SECRET_LABEL = 'Requesty';
const CUSTOM_SOURCE = 'custom';
/** Value of the virtual "Requesty" entry in the Chat Completion Source dropdown. */
const REQUESTY_SOURCE = 'requesty';

const REGIONS = {
    global: 'https://router.requesty.ai/v1',
    eu: 'https://router.eu.requesty.ai/v1',
    us: 'https://router.us.requesty.ai/v1',
    ap: 'https://router.ap.requesty.ai/v1',
};

const REQUESTY_URL_RE = /^https?:\/\/router(\.[a-z0-9-]+)?\.requesty\.ai(\/|$)/i;
const MANAGED_PROVIDER = '__managed__';

const defaultSettings = Object.freeze({
    region: 'global',
    secretId: '',
    model: '',
    favorites: [],
    sort: 'name',
    filterLab: '',
    filterProvider: '',
    onlyFavorites: false,
    onlyReasoning: false,
    onlyVision: false,
    showRegional: false,
    contextMode: 'clamp',
    reasoningEffort: '',
    autoCache: '',
    attribution: true,
    traceByChat: false,
    tags: '',
    /** Custom source settings that were in place before switching to Requesty. */
    prevCustom: null,
});

/** @type {any[]} */
let models = [];
let modelsLoadedFrom = '';
let loadingModels = null;

/* ------------------------------------------------------------------ */
/* Settings                                                            */
/* ------------------------------------------------------------------ */

function settings() {
    if (!extension_settings[MODULE] || typeof extension_settings[MODULE] !== 'object') {
        extension_settings[MODULE] = {};
    }
    const s = extension_settings[MODULE];
    for (const [key, value] of Object.entries(defaultSettings)) {
        if (s[key] === undefined) {
            s[key] = Array.isArray(value) ? [...value] : value;
        }
    }
    if (!REGIONS[s.region]) s.region = 'global';
    return s;
}

function save() {
    saveSettingsDebounced();
}

function getBaseUrl() {
    return REGIONS[settings().region] || REGIONS.global;
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function formatTokens(n) {
    const num = Number(n);
    if (!num || num <= 0) return '—';
    if (num >= 1_000_000) {
        const millions = num % 1_048_576 === 0 ? num / 1_048_576 : num / 1_000_000;
        return `${+millions.toFixed(1)}M`;
    }
    if (num >= 1000) return `${Math.round(num / 1000)}K`;
    return String(num);
}

/** Price per token -> "$x.xx" per 1M tokens */
function formatPrice(perToken) {
    const value = Number(perToken);
    if (!Number.isFinite(value)) return '?';
    if (value === 0) return '免费';
    const perMillion = value * 1_000_000;
    if (perMillion >= 100) return `$${perMillion.toFixed(0)}`;
    if (perMillion >= 1) return `$${perMillion.toFixed(2)}`;
    if (perMillion >= 0.01) return `$${perMillion.toFixed(3)}`;
    return `$${perMillion.toPrecision(2)}`;
}

/** Accepts unix seconds / milliseconds or a date string. */
function formatDate(value) {
    const num = Number(value);
    const date = Number.isFinite(num) && num > 0
        ? new Date(num < 1e12 ? num * 1000 : num)
        : new Date(String(value));
    return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleDateString();
}

function getProvider(model) {
    const id = String(model?.id ?? '');
    return id.includes('/') ? id.split('/')[0] : MANAGED_PROVIDER;
}

function isRegional(model) {
    return /@[a-z0-9-]+$/i.test(String(model?.id ?? ''));
}

function isRequestyUrl(url) {
    return REQUESTY_URL_RE.test(String(url ?? '').trim());
}

/** Whether the Chat Completion source is set up as Requesty (Custom source + Requesty URL). */
function isRequestySource() {
    return oai_settings.chat_completion_source === CUSTOM_SOURCE && isRequestyUrl(oai_settings.custom_url);
}

/** Whether SillyTavern is currently connected through Requesty. */
function isRequestyActive() {
    return main_api === 'openai' && isRequestySource();
}

function findModel(id) {
    return models.find(m => m.id === id);
}

/** Parses a YAML string from Include Body / Headers into a plain object. */
function parseYamlObject(text) {
    if (!text || !String(text).trim()) return {};
    try {
        const parsed = yaml.parse(String(text));
        if (Array.isArray(parsed)) {
            return Object.assign({}, ...parsed.filter(x => x && typeof x === 'object' && !Array.isArray(x)));
        }
        if (parsed && typeof parsed === 'object') return parsed;
    } catch (error) {
        console.warn('[Requesty] Could not parse YAML, leaving it untouched.', error);
        return null;
    }
    return {};
}

/* ------------------------------------------------------------------ */
/* Secrets                                                             */
/* ------------------------------------------------------------------ */

function getCustomSecrets() {
    const list = secret_state?.[SECRET_KEYS.CUSTOM];
    return Array.isArray(list) ? list : [];
}

/** Finds the Requesty key inside the Custom source key list. */
function findRequestySecret() {
    const list = getCustomSecrets();
    const s = settings();
    return list.find(x => s.secretId && x.id === s.secretId)
        ?? list.find(x => String(x.label ?? '').trim().toLowerCase() === SECRET_LABEL.toLowerCase())
        ?? null;
}

async function saveKey(value) {
    const key = String(value ?? '').trim();
    if (!key) {
        toastr.warning('请先粘贴 Requesty API Key。');
        return;
    }

    const existing = findRequestySecret();
    const id = await writeSecret(SECRET_KEYS.CUSTOM, key, SECRET_LABEL);
    if (!id) {
        toastr.error('保存密钥失败，请查看浏览器控制台。');
        return;
    }

    // Replace the previous Requesty key instead of piling up duplicates.
    if (existing && existing.id !== id) {
        await deleteSecret(SECRET_KEYS.CUSTOM, existing.id);
    }

    settings().secretId = id;
    save();
    $('#requesty_key').val('');
    toastr.success('Requesty API Key 已保存到 SillyTavern 密钥库。');

    if (isRequestyActive()) {
        await ensureSecretActive();
        $('#api_button_openai').trigger('click');
    }
    updateKeyState();
    await loadModels(true);
}

function getActiveCustomSecretId() {
    return getCustomSecrets().find(x => x.active)?.id ?? '';
}

/** Makes sure the Requesty key is the active key of the Custom source. */
async function ensureSecretActive() {
    const secret = findRequestySecret();
    if (!secret) return false;
    if (!secret.active) {
        await rotateSecret(SECRET_KEYS.CUSTOM, secret.id);
    }
    return true;
}

/* ------------------------------------------------------------------ */
/* Models                                                              */
/* ------------------------------------------------------------------ */

async function fetchPublicList(url) {
    const response = await fetch(url, { cache: 'no-cache' });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    const data = await response.json();
    return Array.isArray(data?.data) ? data.data : [];
}

/**
 * Asks the SillyTavern server to list models with the stored key
 * (returns the models approved for this key, with full metadata).
 */
async function fetchAuthorizedList(baseUrl, secretId) {
    const response = await fetch('/api/backends/chat-completions/status', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({
            chat_completion_source: CUSTOM_SOURCE,
            custom_url: baseUrl,
            custom_include_headers: '',
            secret_id: secretId,
        }),
        cache: 'no-cache',
    });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    const data = await response.json();
    if (data?.error) throw new Error(data?.message || 'status error');
    return Array.isArray(data?.data) ? data.data : [];
}

async function loadModels(force = false) {
    const baseUrl = getBaseUrl();
    if (!force && models.length && modelsLoadedFrom === baseUrl) {
        renderModelList();
        return models;
    }
    if (loadingModels) return loadingModels;

    $('#requesty_refresh').addClass('requesty-spin');
    $('#requesty_model_count').text('加载中…');

    loadingModels = (async () => {
        let list = [];
        let authorized = false;
        const secret = findRequestySecret();

        if (secret) {
            try {
                list = await fetchAuthorizedList(baseUrl, secret.id);
                authorized = list.length > 0;
            } catch (error) {
                console.warn('[Requesty] Authorized model list failed, falling back to public list.', error);
            }
        }

        if (!list.length) {
            list = await fetchPublicList(`${baseUrl}/models`);
        }

        // Managed (provider-less) routes pick the best provider automatically.
        try {
            const managed = await fetchPublicList(`${baseUrl}/models/managed`);
            const seen = new Set(list.map(m => m.id));
            for (const m of managed) {
                if (m?.id && !seen.has(m.id)) list.push(m);
            }
        } catch (error) {
            console.debug('[Requesty] Managed model list unavailable.', error);
        }

        models = list.filter(m => m && typeof m.id === 'string' && (!m.api || m.api === 'chat'));
        modelsLoadedFrom = baseUrl;
        console.info(`[Requesty] Loaded ${models.length} models (${authorized ? 'authorized' : 'public'} list).`);
        return models;
    })();

    try {
        await loadingModels;
    } catch (error) {
        console.error('[Requesty] Failed to load models', error);
        toastr.error(`无法获取 Requesty 模型列表：${error.message}`);
    } finally {
        loadingModels = null;
        $('#requesty_refresh').removeClass('requesty-spin');
    }

    buildFilterOptions();
    renderModelList();
    renderCurrentModel();
    return models;
}

function buildFilterOptions() {
    const s = settings();
    const labs = [...new Set(models.map(m => m.model_lab).filter(Boolean))].sort();
    const providers = [...new Set(models.map(getProvider))].sort((a, b) => {
        if (a === MANAGED_PROVIDER) return -1;
        if (b === MANAGED_PROVIDER) return 1;
        return a.localeCompare(b);
    });

    const labSelect = $('#requesty_filter_lab').empty().append('<option value="">全部厂商</option>');
    for (const lab of labs) labSelect.append($('<option>').val(lab).text(lab));
    if (s.filterLab && !labs.includes(s.filterLab)) s.filterLab = '';
    labSelect.val(s.filterLab);

    const providerSelect = $('#requesty_filter_provider').empty().append('<option value="">全部服务商</option>');
    for (const p of providers) {
        providerSelect.append($('<option>').val(p).text(p === MANAGED_PROVIDER ? '托管路由（自动选服务商）' : p));
    }
    if (s.filterProvider && !providers.includes(s.filterProvider)) s.filterProvider = '';
    providerSelect.val(s.filterProvider);
}

function getFilteredModels() {
    const s = settings();
    const query = String($('#requesty_search').val() ?? '').trim().toLowerCase();
    const terms = query.split(/\s+/).filter(Boolean);
    const favorites = new Set(s.favorites);

    const list = models.filter(m => {
        if (!s.showRegional && isRegional(m) && m.id !== currentModelId()) return false;
        if (s.onlyFavorites && !favorites.has(m.id)) return false;
        if (s.onlyReasoning && !m.supports_reasoning) return false;
        if (s.onlyVision && !m.supports_vision) return false;
        if (s.filterLab && m.model_lab !== s.filterLab) return false;
        if (s.filterProvider && getProvider(m) !== s.filterProvider) return false;
        if (terms.length) {
            const haystack = `${m.id} ${m.model_lab ?? ''} ${m.model_canonical_name ?? ''}`.toLowerCase();
            if (!terms.every(t => haystack.includes(t))) return false;
        }
        return true;
    });

    const byName = (a, b) => a.id.localeCompare(b.id);
    const price = m => Number(m.input_price ?? 0) + Number(m.output_price ?? 0);
    const sorters = {
        name: byName,
        price: (a, b) => price(a) - price(b) || byName(a, b),
        context: (a, b) => Number(b.context_window ?? 0) - Number(a.context_window ?? 0) || byName(a, b),
        newest: (a, b) => Number(b.created ?? 0) - Number(a.created ?? 0) || byName(a, b),
    };
    list.sort(sorters[s.sort] ?? byName);

    // Favorites float to the top.
    return [...list.filter(m => favorites.has(m.id)), ...list.filter(m => !favorites.has(m.id))];
}

function currentModelId() {
    return isRequestyActive() ? String(oai_settings.custom_model ?? '') : settings().model;
}

function capabilityBadges(m) {
    const badges = [];
    if (getProvider(m) === MANAGED_PROVIDER) badges.push('<span class="requesty-cap requesty-cap-managed" title="托管路由：自动选择服务商并故障转移">自动</span>');
    if (m.supports_reasoning) badges.push('<i class="fa-solid fa-brain" title="支持推理"></i>');
    if (m.supports_vision) badges.push('<i class="fa-solid fa-eye" title="支持识图"></i>');
    if (m.supports_caching) badges.push('<i class="fa-solid fa-database" title="支持提示词缓存"></i>');
    if (m.supports_tool_calling) badges.push('<i class="fa-solid fa-screwdriver-wrench" title="支持工具调用"></i>');
    if (m.retires) badges.push(`<i class="fa-solid fa-hourglass-end requesty-warn" title="计划下线：${escapeHtml(formatDate(m.retires))}"></i>`);
    return badges.join('');
}

const MAX_RENDERED = 400;

function renderModelList() {
    const container = $('#requesty_model_list');
    if (!container.length) return;

    const list = getFilteredModels();
    const current = currentModelId();
    const favorites = new Set(settings().favorites);

    $('#requesty_model_count').text(models.length ? `${list.length} / ${models.length}` : '');

    if (!models.length) {
        container.html('<div class="requesty-empty">尚未加载模型，点击右上角刷新按钮。</div>');
        return;
    }
    if (!list.length) {
        container.html('<div class="requesty-empty">没有符合条件的模型。</div>');
        return;
    }

    const rows = list.slice(0, MAX_RENDERED).map(m => {
        const fav = favorites.has(m.id);
        const selected = m.id === current;
        return `
<div class="requesty-model${selected ? ' selected' : ''}" data-id="${escapeHtml(m.id)}" title="${escapeHtml(m.description ?? '')}">
    <i class="requesty-fav fa-star ${fav ? 'fa-solid' : 'fa-regular'}" data-id="${escapeHtml(m.id)}" title="${fav ? '取消收藏' : '收藏'}"></i>
    <div class="requesty-model-main">
        <div class="requesty-model-id">${escapeHtml(m.id)}</div>
        <div class="requesty-model-meta">
            ${m.model_lab ? `<span class="requesty-lab">${escapeHtml(m.model_lab)}</span>` : ''}
            <span class="requesty-caps">${capabilityBadges(m)}</span>
        </div>
    </div>
    <div class="requesty-model-nums">
        <div title="上下文窗口">${formatTokens(m.context_window)}</div>
        <div class="requesty-price" title="输入 / 输出，美元每百万 token">${formatPrice(m.input_price)} / ${formatPrice(m.output_price)}</div>
    </div>
</div>`;
    });

    if (list.length > MAX_RENDERED) {
        rows.push(`<div class="requesty-empty">还有 ${list.length - MAX_RENDERED} 个模型未显示，请用搜索或筛选缩小范围。</div>`);
    }

    container.html(rows.join(''));
}

function renderCurrentModel() {
    const container = $('#requesty_current');
    if (!container.length) return;

    const id = currentModelId();
    if (!id) {
        container.html('<div class="requesty-muted">尚未选择模型。在下方列表中点击一个模型即可。</div>');
        return;
    }

    const m = findModel(id);
    const pending = !isRequestyActive() ? '<span class="requesty-pending" title="在「聊天补全来源」中选择 Requesty 后生效">未启用</span>' : '';

    if (!m) {
        container.html(`
<div class="requesty-current-head"><b>${escapeHtml(id)}</b>${pending}</div>
<div class="requesty-muted">${models.length ? '列表中没有此模型（可能是路由策略 policy/… 或自定义 ID）。' : ''}</div>`);
        return;
    }

    const efforts = Array.isArray(m.reasoning?.supported_efforts) ? m.reasoning.supported_efforts.join(' / ') : '';
    const cached = m.cached_price !== undefined ? ` · 缓存读取 ${formatPrice(m.cached_price)}` : '';
    const privacy = [];
    if (m.data_used_for_training) privacy.push('<span class="requesty-warn">可能用于训练</span>');
    if (m.data_retention) {
        const days = Number(m.data_retention_days);
        privacy.push(days > 0 ? `服务商保留数据 ${days} 天` : '服务商会保留数据');
    }
    if (m.geolocation) privacy.push(`地区 ${escapeHtml(m.geolocation)}`);

    container.html(`
<div class="requesty-current-head"><b>${escapeHtml(m.id)}</b>${pending}<span class="requesty-caps">${capabilityBadges(m)}</span></div>
<div class="requesty-current-grid">
    <span>上下文 <b>${formatTokens(m.context_window)}</b></span>
    <span>最大输出 <b>${formatTokens(m.max_output_tokens)}</b></span>
    <span>输入 <b>${formatPrice(m.input_price)}</b> · 输出 <b>${formatPrice(m.output_price)}</b>${cached}</span>
    ${efforts ? `<span>推理强度：${escapeHtml(efforts)}</span>` : ''}
    ${privacy.length ? `<span>${privacy.join(' · ')}</span>` : ''}
    ${m.retires ? `<span class="requesty-warn">计划下线：${escapeHtml(formatDate(m.retires))}</span>` : ''}
</div>
${m.description ? `<div class="requesty-desc">${escapeHtml(m.description)}</div>` : ''}`);
}

/* ------------------------------------------------------------------ */
/* Applying model / connection                                         */
/* ------------------------------------------------------------------ */

/** Adjusts context / response length to the model's limits. */
function applyModelLimits(model) {
    const mode = settings().contextMode;
    if (!model || mode === 'off') return;

    const maxContext = Number(model.context_window) || 0;
    if (maxContext > 0) {
        const slider = $('#openai_max_context');
        const sliderMax = Number(slider.attr('max')) || maxContext;
        const target = mode === 'max'
            ? Math.min(maxContext, sliderMax)
            : Math.min(Number(oai_settings.openai_max_context) || maxContext, maxContext);
        if (target !== Number(oai_settings.openai_max_context)) {
            slider.val(target).trigger('input');
        }
    }

    const maxOutput = Number(model.max_output_tokens) || 0;
    if (maxOutput > 0 && Number(oai_settings.openai_max_tokens) > maxOutput) {
        $('#openai_max_tokens').val(maxOutput).trigger('input');
    }
}

/** Selects a model. Applies it right away when Requesty is the active connection. */
function selectModel(id, { silent = false } = {}) {
    const modelId = String(id ?? '').trim();
    if (!modelId) return;

    settings().model = modelId;
    save();

    if (isRequestyActive()) {
        $('#custom_model_id').val(modelId).trigger('input');
        const select = $('#model_custom_select');
        if (select.find('option').filter((_, o) => o.value === modelId).length) {
            select.val(modelId);
        }
        applyModelLimits(findModel(modelId));
        eventSource.emit(event_types.CHATCOMPLETION_MODEL_CHANGED, modelId);
        if (!silent) toastr.success(`已切换到 ${modelId}`, 'Requesty', { timeOut: 2000 });
    } else if (!silent) {
        toastr.info('已选择模型，在「聊天补全来源」中选择 Requesty 后生效。', 'Requesty', { timeOut: 3000 });
    }

    renderModelList();
    renderCurrentModel();
}

/* ------------------------------------------------------------------ */
/* Virtual "Requesty" chat completion source                           */
/* ------------------------------------------------------------------ */

/**
 * Points the Custom source at Requesty. Runs synchronously inside the source
 * <select> change event, before SillyTavern's own handler reconnects.
 */
function enterRequestyMode() {
    const s = settings();
    if (!isRequestyUrl(oai_settings.custom_url)) {
        // Remember the user's own Custom endpoint so "Custom" can restore it later.
        s.prevCustom = {
            url: String(oai_settings.custom_url ?? ''),
            model: String(oai_settings.custom_model ?? ''),
            secretId: getActiveCustomSecretId(),
        };
    }

    const url = getBaseUrl();
    oai_settings.custom_url = url;
    $('#custom_api_url_text').val(url);

    if (s.model) {
        oai_settings.custom_model = s.model;
        $('#custom_model_id').val(s.model);
    }
    save();
}

/** Restores the user's previous Custom endpoint when they pick plain "Custom" again. */
function leaveRequestyMode() {
    const prev = settings().prevCustom ?? {};
    oai_settings.custom_url = String(prev.url ?? '');
    $('#custom_api_url_text').val(oai_settings.custom_url);
    oai_settings.custom_model = String(prev.model ?? '');
    $('#custom_model_id').val(oai_settings.custom_model);
    save();

    const prevSecret = getCustomSecrets().find(x => x.id === prev.secretId);
    if (prevSecret && !prevSecret.active) {
        // Async on purpose: rotateSecret reconnects by itself once done.
        rotateSecret(SECRET_KEYS.CUSTOM, prevSecret.id);
    }
}

/**
 * Runs before SillyTavern's own change handler of the source dropdown.
 * Turns the virtual "Requesty" option into the real Custom source.
 */
function onSourceChangeFirst(event) {
    try {
        const select = /** @type {HTMLSelectElement} */ (this);
        if (select.value === REQUESTY_SOURCE) {
            enterRequestyMode();
            select.value = CUSTOM_SOURCE;
        } else if (select.value === CUSTOM_SOURCE && event?.originalEvent?.isTrusted && isRequestyUrl(oai_settings.custom_url)) {
            // The user deliberately picked "Custom" while Requesty was configured.
            leaveRequestyMode();
        }
    } catch (error) {
        console.error('[Requesty] Source switch failed', error);
    }
}

/** Binds a jQuery handler so that it runs before the handlers bound earlier. */
function bindFirst(element, type, handler) {
    const $el = $(element);
    $el.on(type, handler);
    try {
        const handlers = $._data($el[0], 'events')?.[type];
        if (Array.isArray(handlers) && handlers.length > 1) {
            const own = handlers.pop();
            handlers.splice(handlers.delegateCount || 0, 0, own);
        }
    } catch (error) {
        console.warn('[Requesty] Could not reorder handlers, using fallback.', error);
    }
}

function injectSourceOption() {
    const select = $('#chat_completion_source');
    if (!select.length || select.find(`option[value="${REQUESTY_SOURCE}"]`).length) return;

    const option = $('<option>').val(REQUESTY_SOURCE).text('Requesty');
    // Put it alphabetically into the provider group (the one with OpenRouter).
    const group = select.find('option[value="openrouter"]').parent();
    const target = group.length ? group : select;
    const next = target.children('option').toArray().find(o => o.textContent.localeCompare('Requesty', 'en', { sensitivity: 'base' }) > 0);
    if (next) {
        $(next).before(option);
    } else {
        target.append(option);
    }

    bindFirst(select, 'change', onSourceChangeFirst);
}

/** Shows "Requesty" in the dropdown and swaps the Custom form for the Requesty panel. */
function syncSourceDisplay() {
    const select = /** @type {HTMLSelectElement|undefined} */ ($('#chat_completion_source')[0]);
    const requesty = isRequestySource();

    if (select) {
        if (requesty && select.value !== REQUESTY_SOURCE) {
            select.value = REQUESTY_SOURCE;
        } else if (!requesty && select.value === REQUESTY_SOURCE) {
            select.value = oai_settings.chat_completion_source;
        }
    }
    $('body').toggleClass('requesty-mode', requesty);
}

async function onSourceChanged() {
    // Fallback in case our handler could not run first.
    if (oai_settings.chat_completion_source === REQUESTY_SOURCE) {
        $('#chat_completion_source').val(REQUESTY_SOURCE).trigger('change');
        return;
    }

    syncSourceDisplay();
    if (!isRequestyActive()) return;

    applyModelLimits(findModel(String(oai_settings.custom_model ?? '')));
    refreshAll();
    if (!models.length) loadModels().catch(() => { /* reported inside */ });
    await ensureSecretActive();
    updateKeyState();
}

/** Switches SillyTavern to Requesty and connects (used by the slash command). */
async function activateRequesty() {
    if (main_api !== 'openai') {
        $('#main_api').val('openai').trigger('change');
    }
    if (!isRequestySource()) {
        $('#chat_completion_source').val(REQUESTY_SOURCE).trigger('change');
    }
    if (!findRequestySecret()) {
        toastr.warning('请先在 Requesty 面板中填写并保存 API Key。', 'Requesty');
        return;
    }
    await ensureSecretActive();
    $('#api_button_openai').trigger('click');
}

/* ------------------------------------------------------------------ */
/* Request hook                                                        */
/* ------------------------------------------------------------------ */

function resolveReasoningEffort() {
    const value = settings().reasoningEffort;
    if (!value) return null;
    if (value !== 'follow') return value;

    switch (oai_settings.reasoning_effort) {
        case 'auto':
        case undefined:
        case null:
        case '':
            return null;
        case 'min':
            return 'none';
        default:
            return oai_settings.reasoning_effort;
    }
}

function onChatCompletionSettingsReady(data) {
    try {
        if (!data || data.chat_completion_source !== CUSTOM_SOURCE || !isRequestyUrl(data.custom_url)) {
            return;
        }

        const s = settings();

        // ---- body ----
        const body = parseYamlObject(data.custom_include_body);
        if (body) {
            let changed = false;
            const requesty = {};

            if (s.autoCache === 'on') requesty.auto_cache = true;
            if (s.autoCache === 'off') requesty.auto_cache = false;

            const tags = String(s.tags ?? '').split(',').map(t => t.trim()).filter(Boolean);
            if (tags.length) requesty.tags = tags;

            if (s.traceByChat) {
                const chatId = getContext()?.getCurrentChatId?.();
                if (chatId) requesty.trace_id = String(chatId);
            }

            if (Object.keys(requesty).length) {
                const userRequesty = body.requesty && typeof body.requesty === 'object' ? body.requesty : {};
                body.requesty = { ...requesty, ...userRequesty };
                changed = true;
            }

            const effort = resolveReasoningEffort();
            if (effort && body.reasoning_effort === undefined) {
                body.reasoning_effort = effort;
                changed = true;
            }

            if (changed) {
                data.custom_include_body = yaml.stringify(body);
            }
        }

        // ---- headers ----
        if (s.attribution) {
            const headers = parseYamlObject(data.custom_include_headers);
            if (headers) {
                const hasHeader = name => Object.keys(headers).some(k => k.toLowerCase() === name.toLowerCase());
                let changed = false;
                if (!hasHeader('X-Title')) {
                    headers['X-Title'] = 'SillyTavern';
                    changed = true;
                }
                if (!hasHeader('HTTP-Referer')) {
                    headers['HTTP-Referer'] = 'https://sillytavern.app';
                    changed = true;
                }
                if (changed) {
                    data.custom_include_headers = yaml.stringify(headers);
                }
            }
        }
    } catch (error) {
        console.error('[Requesty] Failed to apply request options', error);
    }
}

/* ------------------------------------------------------------------ */
/* UI state                                                            */
/* ------------------------------------------------------------------ */

function updateKeyState() {
    const secret = findRequestySecret();
    const el = $('#requesty_key_state');
    if (secret) {
        el.html(`已保存：<code>${escapeHtml(secret.value ?? '••••')}</code>${secret.active ? '' : '（当前不是 Custom 源的活动密钥，连接时会自动切换）'}`);
        $('#requesty_key').attr('placeholder', '已保存，粘贴新 Key 可替换');
    } else {
        el.text('尚未保存密钥。密钥保存在 SillyTavern 的密钥库（Custom 源下，标签为 “Requesty”）。');
        $('#requesty_key').attr('placeholder', '粘贴 Requesty API Key');
    }
}

function refreshAll() {
    syncSourceDisplay();
    updateKeyState();
    renderModelList();
    renderCurrentModel();
}

function syncControls() {
    const s = settings();
    $('#requesty_region').val(s.region);
    $('#requesty_sort').val(s.sort);
    $('#requesty_only_fav').prop('checked', !!s.onlyFavorites);
    $('#requesty_only_reasoning').prop('checked', !!s.onlyReasoning);
    $('#requesty_only_vision').prop('checked', !!s.onlyVision);
    $('#requesty_show_regional').prop('checked', !!s.showRegional);
    $('#requesty_context_mode').val(s.contextMode);
    $('#requesty_reasoning').val(s.reasoningEffort);
    $('#requesty_auto_cache').val(s.autoCache);
    $('#requesty_attribution').prop('checked', !!s.attribution);
    $('#requesty_trace').prop('checked', !!s.traceByChat);
    $('#requesty_tags').val(s.tags);
}

function bindControls() {
    const s = () => settings();

    $('#requesty_key_save').on('click', () => saveKey($('#requesty_key').val()));
    $('#requesty_key').on('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            saveKey($('#requesty_key').val());
        }
    });
    $('#requesty_refresh').on('click', () => loadModels(true));

    $('#requesty_region').on('change', async function () {
        s().region = String($(this).val());
        save();
        if (isRequestyActive()) {
            $('#custom_api_url_text').val(getBaseUrl()).trigger('input');
            $('#api_button_openai').trigger('click');
        }
        await loadModels(true);
    });

    let searchTimer;
    $('#requesty_search').on('input', () => {
        clearTimeout(searchTimer);
        searchTimer = setTimeout(renderModelList, 120);
    });

    const bindSelect = (selector, key) => $(selector).on('change', function () {
        s()[key] = String($(this).val());
        save();
        renderModelList();
    });
    bindSelect('#requesty_filter_lab', 'filterLab');
    bindSelect('#requesty_filter_provider', 'filterProvider');
    bindSelect('#requesty_sort', 'sort');

    const bindCheck = (selector, key, rerender = true) => $(selector).on('change', function () {
        s()[key] = $(this).prop('checked');
        save();
        if (rerender) renderModelList();
    });
    bindCheck('#requesty_only_fav', 'onlyFavorites');
    bindCheck('#requesty_only_reasoning', 'onlyReasoning');
    bindCheck('#requesty_only_vision', 'onlyVision');
    bindCheck('#requesty_show_regional', 'showRegional');
    bindCheck('#requesty_attribution', 'attribution', false);
    bindCheck('#requesty_trace', 'traceByChat', false);

    $('#requesty_context_mode').on('change', function () {
        s().contextMode = String($(this).val());
        save();
        if (isRequestyActive()) applyModelLimits(findModel(currentModelId()));
    });
    $('#requesty_reasoning').on('change', function () {
        s().reasoningEffort = String($(this).val());
        save();
    });
    $('#requesty_auto_cache').on('change', function () {
        s().autoCache = String($(this).val());
        save();
    });
    $('#requesty_tags').on('input', function () {
        s().tags = String($(this).val());
        save();
    });

    $('#requesty_manual_apply').on('click', () => {
        const id = String($('#requesty_manual').val() ?? '').trim();
        if (!id) return;
        selectModel(id);
        $('#requesty_manual').val('');
    });
    $('#requesty_manual').on('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            $('#requesty_manual_apply').trigger('click');
        }
    });

    $('#requesty_model_list')
        .on('click', '.requesty-fav', function (e) {
            e.stopPropagation();
            const id = String($(this).data('id'));
            const favorites = new Set(s().favorites);
            if (favorites.has(id)) favorites.delete(id); else favorites.add(id);
            s().favorites = [...favorites];
            save();
            renderModelList();
        })
        .on('click', '.requesty-model', function () {
            selectModel(String($(this).attr('data-id')));
        });

    // Keep in sync with changes made through SillyTavern's own controls.
    $('#custom_api_url_text').on('input', () => setTimeout(refreshAll));
    $('#custom_model_id').on('input', () => {
        if (isRequestyActive() && oai_settings.custom_model) {
            settings().model = String(oai_settings.custom_model);
            save();
        }
        setTimeout(() => {
            renderModelList();
            renderCurrentModel();
        });
    });
}

/* ------------------------------------------------------------------ */
/* Slash commands                                                      */
/* ------------------------------------------------------------------ */

function registerSlashCommands() {
    try {
        SlashCommandParser.addCommandObject(SlashCommand.fromProps({
            name: 'requesty-model',
            helpString: '切换 Requesty 模型；不带参数时返回当前模型 ID。例：<code>/requesty-model anthropic/claude-sonnet-5-5</code>',
            returns: '当前模型 ID',
            unnamedArgumentList: [
                SlashCommandArgument.fromProps({
                    description: '模型 ID',
                    typeList: [ARGUMENT_TYPE.STRING],
                    isRequired: false,
                    enumProvider: () => models.map(m => new SlashCommandEnumValue(m.id, m.model_lab ?? '')),
                }),
            ],
            callback: async (_args, value) => {
                const id = String(value ?? '').trim();
                if (id) {
                    if (!models.length) await loadModels();
                    selectModel(id, { silent: true });
                }
                return currentModelId();
            },
        }));

        SlashCommandParser.addCommandObject(SlashCommand.fromProps({
            name: 'requesty-connect',
            helpString: '切换到 Requesty 并连接（使用已保存的 Key 和模型）。',
            callback: async () => {
                await activateRequesty();
                return '';
            },
        }));
    } catch (error) {
        console.warn('[Requesty] Could not register slash commands', error);
    }
}

/* ------------------------------------------------------------------ */
/* Init                                                                */
/* ------------------------------------------------------------------ */

async function injectPanel() {
    if ($('#requesty_panel').length) return;

    const response = await fetch(new URL('./panel.html', import.meta.url));
    const html = await response.text();
    const customForm = $('#custom_form');
    if (customForm.length) {
        customForm.before(html);
    } else {
        $('#chat_completion_source').after(html);
    }
}

jQuery(async () => {
    try {
        settings();
        await injectPanel();
        injectSourceOption();
        syncControls();
        bindControls();
        registerSlashCommands();

        eventSource.on(event_types.CHAT_COMPLETION_SETTINGS_READY, onChatCompletionSettingsReady);
        eventSource.on(event_types.CHATCOMPLETION_SOURCE_CHANGED, onSourceChanged);

        for (const type of [
            event_types.MAIN_API_CHANGED,
            event_types.CHATCOMPLETION_MODEL_CHANGED,
            event_types.CONNECTION_PROFILE_LOADED,
            event_types.OAI_PRESET_CHANGED_AFTER,
            event_types.SETTINGS_UPDATED,
            event_types.ONLINE_STATUS_CHANGED,
            event_types.SECRET_WRITTEN,
            event_types.SECRET_DELETED,
            event_types.SECRET_ROTATED,
        ]) {
            if (type) eventSource.on(type, () => setTimeout(refreshAll));
        }

        eventSource.on(event_types.APP_READY, async () => {
            await readSecretState();
            refreshAll();
            loadModels().catch(() => { /* reported inside */ });
        });

        refreshAll();
        console.info('[Requesty] Extension loaded.');
    } catch (error) {
        console.error('[Requesty] Failed to initialize', error);
    }
});
