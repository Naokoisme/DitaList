(function () {
  'use strict';
  if (!window.DidaNative || window.didaLocal) return;
  var pending = new Map();
  var sequence = 0;
  function request(method, payload) {
    return new Promise(function (resolve, reject) {
      var id = String(++sequence);
      pending.set(id, { resolve: resolve, reject: reject });
      try { window.DidaNative.invoke(id, method, JSON.stringify(payload === undefined ? null : payload)); }
      catch (error) { pending.delete(id); reject(error); }
    });
  }
  Object.defineProperty(window, '__didaNativeReply', {
    value: function (id, ok, payload) {
      var callback = pending.get(id);
      if (!callback) return;
      pending.delete(id);
      try {
        var value = JSON.parse(payload);
        if (ok) callback.resolve(value);
        else callback.reject(new Error(typeof value === 'string' ? value : '本地操作失败'));
      } catch (error) { callback.reject(error); }
    },
    configurable: false,
    writable: false,
  });
  Object.defineProperty(window, 'didaLocal', {
    value: Object.freeze({
      load: function () { return request('load'); },
      save: function (data) { return request('save', data); },
      exportBackup: function (data) { return request('export', data); },
      importBackup: function () { return request('import'); },
      revealData: function () { return request('reveal'); },
      notify: function (title, body) { return request('notify', { title: title, body: body }); },
      windowAction: function () {},
    }),
    configurable: false,
    writable: false,
  });
})();
