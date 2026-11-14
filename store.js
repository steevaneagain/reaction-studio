'use strict';
/* Saves things on the phone (IndexedDB), so a reload or a closed tab doesn't lose your clips.
   - "session": the reaction you're working on (source video + clips + edits)
   - "videos":  finished videos ("My videos") */
const Store = (() => {
  let dbp;
  function db() {
    if (!dbp) {
      dbp = new Promise((resolve, reject) => {
        const req = indexedDB.open('reaction-studio', 1);
        req.onupgradeneeded = () => {
          req.result.createObjectStore('kv');
          req.result.createObjectStore('videos', { keyPath: 'id' });
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    }
    return dbp;
  }
  async function tx(store, mode, fn) {
    const d = await db();
    return new Promise((resolve, reject) => {
      const t = d.transaction(store, mode);
      const s = t.objectStore(store);
      let out;
      Promise.resolve(fn(s)).then(r => { out = r; });
      t.oncomplete = () => resolve(out && out.result !== undefined && out instanceof IDBRequest ? out.result : out);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  }
  const reqResult = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

  return {
    async get(key) { const d = await db(); return reqResult(d.transaction('kv').objectStore('kv').get(key)); },
    set(key, value) { return tx('kv', 'readwrite', s => { s.put(value, key); }); },
    del(key) { return tx('kv', 'readwrite', s => { s.delete(key); }); },
    async listVideos() {
      const d = await db();
      const all = await reqResult(d.transaction('videos').objectStore('videos').getAll());
      return all.sort((a, b) => b.created - a.created);
    },
    addVideo(v) { return tx('videos', 'readwrite', s => { s.put(v); }); },
    delVideo(id) { return tx('videos', 'readwrite', s => { s.delete(id); }); },
    // Ask the phone not to clear our storage when space runs low.
    persist() { try { navigator.storage?.persist?.(); } catch {} },
  };
})();
