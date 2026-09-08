/**
 * AIManager — robust multi-key, multi-provider rotator.
 */
class AIManager {
  constructor() {
    this.groqKeys = [];
    this.geminiKeys = [];
    this.lastUsed = null; // {provider, index} — for the UI indicator
    this.deadKeys = new Set(); // "provider:index" that already failed this session
    this.loadFromStorage();
  }

  loadFromStorage() {
    try {
      const raw = localStorage.getItem('dnd_ai_keys');
      if (raw) {
        const parsed = JSON.parse(raw);
        this.groqKeys = (parsed.groq || []).filter(Boolean).slice(0, 3);
        this.geminiKeys = (parsed.gemini || []).filter(Boolean).slice(0, 2);
      }
    } catch (e) { /* ignore corrupt storage */ }
  }

  saveToStorage(groqKeys = [], geminiKeys = []) {
    // Always set the keys in memory first: even if localStorage fails
    // below, the app just keeps working for the rest of this session.
    this.groqKeys = groqKeys.filter(Boolean).slice(0, 3);
    this.geminiKeys = geminiKeys.filter(Boolean).slice(0, 2);
    this.deadKeys.clear();
    try {
      localStorage.setItem('dnd_ai_keys', JSON.stringify({
        groq: this.groqKeys, gemini: this.geminiKeys
      }));
      return true; // succeeded: also persists after a reload
    } catch (e) {
      // localStorage can be blocked (private mode, browser settings,
      // certain embedded webviews, etc.) — that shouldn't break the
      // rest of the app.
      console.warn('[AIManager] could not save keys locally:', e);
      return false; // keys still work for this session
    }
  }

  hasAnyKey() {
    return this.groqKeys.length > 0 || this.geminiKeys.length > 0;
  }

  _candidateList() {
    const list = [];
    this.groqKeys.forEach((key, i) => list.push({ provider: 'groq', key, index: i }));
    this.geminiKeys.forEach((key, i) => list.push({ provider: 'gemini', key, index: i }));
    return list;
  }

  _isFailoverWorthy(status, bodyText) {
    if ([429, 401, 403].includes(status)) return true;
    const t = (bodyText || '').toLowerCase();
    return t.includes('quota') || t.includes('rate limit') || t.includes('invalid api key');
  }

  async chat(messages) {
    const candidates = this._candidateList();
    if (candidates.length === 0) {
      throw new Error('No AI keys set. Click "Set AI keys" on the title screen.');
    }

    let lastError = null;
    for (const cand of candidates) {
      const dedupeKey = `${cand.provider}:${cand.index}`;
      if (this.deadKeys.has(dedupeKey)) continue;

      try {
        const text = cand.provider === 'groq'
          ? await this._callGroq(cand.key, messages)
          : await this._callGemini(cand.key, messages);
        this.lastUsed = { provider: cand.provider, index: cand.index };
        return text;
      } catch (err) {
        lastError = err;
        if (err.failoverWorthy) {
          this.deadKeys.add(dedupeKey);
          console.warn(`[AIManager] key ${dedupeKey} failed (${err.message}), switching to the next one...`);
          continue;
        }
        continue;
      }
    }
    throw new Error('All AI keys are exhausted or invalid. Last error: ' + (lastError?.message || 'unknown'));
  }

  async _callGroq(key, messages) {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${key}`
      },
      body: JSON.stringify({
        // Model ID: llama-3.3-70b-versatile was decommissioned by Groq
        // as of August 16, 2026. Check
        // https://console.groq.com/docs/deprecations if you ever see
        // an unknown/removed model error here again.
        model: 'openai/gpt-oss-120b',
        messages,
        temperature: 0.9,
        max_tokens: 1200
      })
    });
    const bodyText = await res.text();
    if (!res.ok) {
      const err = new Error(`Groq HTTP ${res.status}: ${bodyText.slice(0, 200)}`);
      err.failoverWorthy = this._isFailoverWorthy(res.status, bodyText);
      throw err;
    }
    const data = JSON.parse(bodyText);
    return data.choices?.[0]?.message?.content || '';
  }

  async _callGemini(key, messages) {
    const systemMsg = messages.find(m => m.role === 'system');
    const rest = messages.filter(m => m.role !== 'system');

    // Prevent consecutive duplicate roles for Gemini
    const contents = [];
    for (const m of rest) {
      const role = m.role === 'assistant' ? 'model' : 'user';
      if (contents.length > 0 && contents[contents.length - 1].role === role) {
        contents[contents.length - 1].parts[0].text += `\n\n${m.content}`;
      } else {
        contents.push({ role, parts: [{ text: m.content }] });
      }
    }

    const body = {
      contents,
      ...(systemMsg ? { systemInstruction: { parts: [{ text: systemMsg.content }] } } : {}),
      generationConfig: { temperature: 0.9, maxOutputTokens: 1200 }
    };

    // Model ID: Google replaces this fairly regularly (e.g. gemini-2.0-flash
    // was fully retired as of June 1, 2026, resulting in a 404). This is
    // the current GA version at the time of writing; check
    // https://ai.google.dev/gemini-api/docs/models if you ever see a
    // "model not found" error here again.
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent?key=${key}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      }
    );
    const bodyText = await res.text();
    if (!res.ok) {
      const err = new Error(`Gemini HTTP ${res.status}: ${bodyText.slice(0, 200)}`);
      err.failoverWorthy = this._isFailoverWorthy(res.status, bodyText);
      throw err;
    }
    const data = JSON.parse(bodyText);
    return data.candidates?.[0]?.content?.parts?.map(p => p.text).join('') || '';
  }
}

window.aiManager = new AIManager();