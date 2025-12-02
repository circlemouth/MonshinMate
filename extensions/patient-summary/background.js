'use strict';

const API_KEY_HEADER = 'X-MonshinMate-Api-Key';
const BACKGROUND_MESSAGES = {
  missingSettings: '設定が未完了です。アイコンから設定してください。',
  missingPatientInfo: '患者情報が取得できませんでした。',
  apiError: (status, detail) => {
    if (status === 401) return 'APIキーが無効です。管理画面でキーを確認してください。';
    if (status === 404) return '最新の問診が見つかりませんでした。患者名・生年月日と確定済みかをご確認ください。';
    return detail ? `APIエラー (${status}): ${detail}` : `API通信で${status}エラーが発生しました。`;
  },
  markdownMissing: '問診結果が届きませんでした。',
  genericError: '処理に失敗しました。',
  copyFailed: 'クリップボードへのコピーに失敗しました。',
};

const friendlyBackgroundMessages = new Set(
  Object.values(BACKGROUND_MESSAGES).filter((value) => typeof value === 'string')
);

const friendlyBackgroundPrefixes = [
  'APIエラー (',
  'APIキーが無効です',
  '最新の問診が見つかりませんでした',
];

const isFriendlyBackgroundMessage = (text) =>
  Boolean(
    text &&
      (friendlyBackgroundMessages.has(text) ||
        text.startsWith('API通信で') ||
        friendlyBackgroundPrefixes.some((prefix) => text.startsWith(prefix)))
  );

// 日付フォーマット等のユーティリティ（options.jsと重複するが、モジュール化されていないため再定義）
const formatIso = (year, month, day) => {
    const pad = (value) => String(value).padStart(2, '0');
    return `${String(year).padStart(4, '0')}-${pad(month)}-${pad(day)}`;
};

const isValidDate = (year, month, day) => {
    if (month < 1 || month > 12) return false;
    if (day < 1 || day > 31) return false;
    const candidate = new Date(year, month - 1, day);
    return candidate.getFullYear() === year && candidate.getMonth() === month - 1 && candidate.getDate() === day;
};

const normalizeStandardDate = (value) => {
    // まず末尾の「生」などを除去し、括弧内の和暦を除去
    let cleaned = value
        .replace(/[\s　]+生.*$/g, '') // 「生」以降を除去
        .replace(/\(.*?\)/g, '') // 括弧内（和暦）を除去
        .replace(/年|月/g, '-')
        .replace(/日/g, '')
        .replace(/[./\\]/g, '-')
        .replace(/\s+/g, '-')
        .replace(/-+/g, '-');

    const standardMatch = cleaned.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (standardMatch) {
        const [, year, month, day] = standardMatch;
        const y = Number(year);
        const m = Number(month);
        const d = Number(day);
        if (isValidDate(y, m, d)) {
            return formatIso(y, m, d);
        }
    }
    const altMatch = cleaned.match(/(\d{1,2})-(\d{1,2})-(\d{4})/);
    if (altMatch) {
        const [, month, day, year] = altMatch;
        const y = Number(year);
        const m = Number(month);
        const d = Number(day);
        if (isValidDate(y, m, d)) {
            return formatIso(y, m, d);
        }
    }
    const digitsOnly = value.replace(/\D/g, '');
    if (digitsOnly.length === 8) {
        const year = Number(digitsOnly.slice(0, 4));
        const month = Number(digitsOnly.slice(4, 6));
        const day = Number(digitsOnly.slice(6, 8));
        if (isValidDate(year, month, day)) {
            return formatIso(year, month, day);
        }
    }
    return null;
};

const eraDefinitions = [
    { names: ['令和', 'reiwa', 'Reiwa', 'R'], base: 2018 },
    { names: ['平成', 'heisei', 'Heisei', 'H'], base: 1988 },
    { names: ['昭和', 'showa', 'Showa', 'S'], base: 1925 },
    { names: ['大正', 'taisho', 'Taisho', 'T'], base: 1911 },
    { names: ['明治', 'meiji', 'Meiji', 'M'], base: 1867 },
];

const extractMonthDay = (text) => {
    if (!text) return null;
    const monthMatch = text.match(/(\d{1,2})月/);
    const dayMatch = text.match(/(\d{1,2})日/);
    if (monthMatch && dayMatch) {
        const month = Number(monthMatch[1]);
        const day = Number(dayMatch[1]);
        if (isValidDate(2000, month, day)) {
            return { month, day };
        }
    }
    const pairMatch = text.match(/(\d{1,2})\D+(\d{1,2})/);
    if (pairMatch) {
        const month = Number(pairMatch[1]);
        const day = Number(pairMatch[2]);
        if (isValidDate(2000, month, day)) {
            return { month, day };
        }
    }
    const digits = text.match(/(\d{1,2})/g);
    if (digits && digits.length >= 2) {
        const month = Number(digits[0]);
        const day = Number(digits[1]);
        if (isValidDate(2000, month, day)) {
            return { month, day };
        }
    }
    return null;
};

const normalizeEraDate = (value) => {
    const trimmed = value.trim();
    for (const definition of eraDefinitions) {
        const regex = new RegExp(`(${definition.names.join('|')})\\s*(元|\\d{1,2})`, 'i');
        const match = trimmed.match(regex);
        if (!match) continue;
        const [, eraRaw, yearToken] = match;
        const base = definition.base;
        const yearNumber = yearToken === '元' ? 1 : Number(yearToken);
        if (!Number.isFinite(yearNumber)) {
            continue;
        }
        const year = base + yearNumber;
        const remainder = trimmed.slice(match.index + match[0].length);
        const monthDay = extractMonthDay(remainder);
        if (!monthDay) continue;
        if (isValidDate(year, monthDay.month, monthDay.day)) {
            return formatIso(year, monthDay.month, monthDay.day);
        }
    }
    return null;
};

const normalizeDob = (value) => {
    if (!value) return '';
    const trimmed = value.trim();
    if (!trimmed) return '';
    return normalizeStandardDate(trimmed) || normalizeEraDate(trimmed) || trimmed;
};

// ページ内で実行されるスクリプト：XPathから情報を取得
const extractPatientInfo = (nameXPath, dobXPath) => {
    const evalXPath = (xpath) => {
        if (!xpath) return null;
        try {
            const evaluator = document.evaluate(xpath, document, null, XPathResult.STRING_TYPE, null);
            const value = evaluator ? evaluator.stringValue : '';
            return typeof value === 'string' ? value.trim() : null;
        } catch (error) {
            return null;
        }
    };
    return {
        name: evalXPath(nameXPath),
        dob: evalXPath(dobXPath),
    };
};

// ページ内で実行されるスクリプト：クリップボードにコピー＆通知
const copyAndNotify = (text) => {
    // クリップボードへの書き込み
    navigator.clipboard.writeText(text).then(() => {
        // 通知の表示（ページ内トースト的なものを作成して表示）
        const div = document.createElement('div');
        div.style.position = 'fixed';
        div.style.top = '20px';
        div.style.right = '20px';
        div.style.backgroundColor = '#059669';
        div.style.color = 'white';
        div.style.padding = '12px 24px';
        div.style.borderRadius = '8px';
        div.style.zIndex = '999999';
        div.style.boxShadow = '0 4px 6px rgba(0, 0, 0, 0.1)';
        div.style.fontFamily = 'sans-serif';
        div.style.fontSize = '14px';
        div.style.fontWeight = 'bold';
        div.style.transition = 'opacity 0.5s ease';
        div.textContent = '問診結果をコピーしました';
        document.body.appendChild(div);

        setTimeout(() => {
            div.style.opacity = '0';
            setTimeout(() => div.remove(), 500);
        }, 3000);
    }).catch(err => {
        console.error('Clipboard write failed', err);
        alert(BACKGROUND_MESSAGES.copyFailed);
    });
};

const showError = (message) => {
    const div = document.createElement('div');
    div.style.position = 'fixed';
    div.style.top = '20px';
    div.style.right = '20px';
    div.style.backgroundColor = '#ef4444';
    div.style.color = 'white';
    div.style.padding = '12px 24px';
    div.style.borderRadius = '8px';
    div.style.zIndex = '999999';
    div.style.boxShadow = '0 4px 6px rgba(0, 0, 0, 0.1)';
    div.style.fontFamily = 'sans-serif';
    div.style.fontSize = '14px';
    div.style.fontWeight = 'bold';
    div.textContent = message;
    document.body.appendChild(div);
    setTimeout(() => div.remove(), 5000);
};

chrome.commands.onCommand.addListener(async (command) => {
    if (command !== 'fetch-patient-summary') return;

    // アクティブなタブを取得
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.id) return;

    try {
        // 設定の読み込み
        const settings = await chrome.storage.sync.get({
            apiUrl: '',
            apiKey: '',
            nameXPath: '',
            dobXPath: ''
        });

        if (!settings.apiUrl || !settings.apiKey || !settings.nameXPath || !settings.dobXPath) {
            chrome.scripting.executeScript({
                target: { tabId: tab.id },
                func: showError,
                args: [BACKGROUND_MESSAGES.missingSettings]
            });
            return;
        }

        // 1. ページから情報を取得
        const results = await chrome.scripting.executeScript({
            target: { tabId: tab.id, allFrames: true },
            func: extractPatientInfo,
            args: [settings.nameXPath, settings.dobXPath]
        });

        // 全フレームから有効な結果を探す
        let name = null;
        let dob = null;

        for (const frameResult of results) {
            const info = frameResult.result;
            if (info && info.name) name = info.name;
            if (info && info.dob) dob = info.dob;
            if (name && dob) break; // 両方見つかったら終了
        }

        if (!name || !dob) {
            throw new Error(BACKGROUND_MESSAGES.missingPatientInfo);
        }

        const normalizedDob = normalizeDob(dob);

        // 2. APIに送信してMarkdownを取得
        const response = await fetch(settings.apiUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                [API_KEY_HEADER]: settings.apiKey,
            },
            body: JSON.stringify({ patient_name: name, dob: normalizedDob }),
        });

        if (!response.ok) {
            const detail = await response.json().catch(() => ({}));
            const detailText = detail?.detail || '';
            if (detailText) {
                console.error('API error detail:', detailText);
            }
            throw new Error(BACKGROUND_MESSAGES.apiError(response.status, detailText));
        }

        const payload = await response.json();
        if (!payload?.markdown) {
            throw new Error(BACKGROUND_MESSAGES.markdownMissing);
        }

        // 3. 結果をクリップボードにコピー＆通知
        await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: copyAndNotify,
            args: [payload.markdown]
        });

    } catch (error) {
        console.error(error);
        const displayMessage = isFriendlyBackgroundMessage(error?.message)
            ? error.message
            : BACKGROUND_MESSAGES.genericError;
        chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: showError,
            args: [displayMessage]
        });
    }
});
