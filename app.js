(function () {
  'use strict';

  var $ = function (sel, root) {
    return (root || document).querySelector(sel);
  };
  var $$ = function (sel, root) {
    return Array.prototype.slice.call((root || document).querySelectorAll(sel));
  };

  /* ------------------------------------------------------------------ */
  /* 常量与工具                                                           */
  /* ------------------------------------------------------------------ */

  var els = {
    form: $('#parse-form'),
    input: $('#url-input'),
    parseBtn: $('#parse-btn'),
    pasteBtn: $('#paste-btn'),
    clearBtn: $('#clear-btn'),
    status: $('#status'),
    result: $('#result'),
    examples: $('#examples'),
    overlay: $('#preview-overlay'),
    previewBody: $('#preview-body'),
    previewFoot: $('#preview-foot'),
    previewTitle: $('#preview-title'),
    previewClose: $('#preview-close'),
    toast: $('#toast')
  };

  var state = {
    tweet: null,
    loading: false,
    controller: null,
    qrcodeOverlay: null
  };

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function extractTweetId(input) {
    if (!input) return null;
    var text = String(input).trim();
    if (/^\d{8,25}$/.test(text)) return text;
    var m = text.match(/(?:status|statuses)\/(\d{8,25})/i);
    if (m) return m[1];
    var plain = text.match(/(?:^|\s)(\d{15,25})(?:\s|$)/);
    return plain ? plain[1] : null;
  }

  function formatDuration(seconds) {
    var total = Math.round(Number(seconds) || 0);
    if (!total) return '--:--';
    var m = Math.floor(total / 60);
    var s = total % 60;
    return m + ':' + String(s).padStart(2, '0');
  }

  function formatCount(num) {
    var n = Number(num) || 0;
    if (n >= 100000000) return (n / 100000000).toFixed(1).replace(/\.0$/, '') + ' 亿';
    if (n >= 10000) return (n / 10000).toFixed(1).replace(/\.0$/, '') + ' 万';
    if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
    return String(n);
  }

  function formatDate(ts) {
    if (!ts) return '';
    try {
      return new Intl.DateTimeFormat('zh-CN', {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
      }).format(new Date(ts));
    } catch (err) {
      return new Date(ts).toLocaleString();
    }
  }

  function formatMbps(bitrate) {
    var value = Number(bitrate) || 0;
    if (!value) return '';
    return (value / 1e6).toFixed(value >= 1e6 ? 1 : 2) + ' Mbps';
  }

  function safeFileName(name, fallback) {
    var cleaned = String(name || '')
      .replace(/[\\/:*?"<>|\r\n\t]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 80);
    return (cleaned || fallback) + '.mp4';
  }

  /* ------------------------------------------------------------------ */
  /* 解析逻辑                                                             */
  /* ------------------------------------------------------------------ */

  function dimsFromUrl(url) {
    var m = String(url).match(/(\d{2,5})x(\d{2,5})(?=[\/.])/);
    if (!m) return null;
    var width = Number(m[1]);
    var height = Number(m[2]);
    if (!width || !height) return null;
    return { width: width, height: height };
  }

  function qualityLabel(width, height) {
    var short = Math.min(width || 0, height || 0);
    if (!short) return '原始画质';
    if (short >= 1080) return '1080p';
    if (short >= 720) return '720p';
    if (short >= 480) return '480p';
    if (short >= 360) return '360p';
    if (short >= 240) return '240p';
    return short + 'p';
  }

  function buildFormats(rawVariants, rawFormats, fallbackUrl, fallbackW, fallbackH) {
    var pool = [];
    var i;

    for (i = 0; i < (rawVariants || []).length; i++) {
      var v = rawVariants[i];
      var isMp4 =
        v.content_type === 'video/mp4' ||
        (!v.content_type && (v.container === 'mp4' || /\.mp4(?:$|\?)/i.test(v.url || '')));
      if (isMp4 && v.url) pool.push(v);
    }
    if (!pool.length) {
      for (i = 0; i < (rawFormats || []).length; i++) {
        var f = rawFormats[i];
        if (f.url && (f.container === 'mp4' || /\.mp4(?:$|\?)/i.test(f.url))) pool.push(f);
      }
    }
    if (fallbackUrl && !pool.some(function (item) { return item.url === fallbackUrl; })) {
      pool.push({ url: fallbackUrl, bitrate: 0 });
    }

    var seen = {};
    var formats = [];
    pool.forEach(function (item) {
      if (!item || !item.url || seen[item.url]) return;
      seen[item.url] = true;
      var dims = dimsFromUrl(item.url);
      if (!dims && fallbackW && fallbackH) dims = { width: fallbackW, height: fallbackH };
      var width = dims ? dims.width : 0;
      var height = dims ? dims.height : 0;
      formats.push({
        url: item.url,
        width: width,
        height: height,
        label: qualityLabel(width, height),
        resolution: width && height ? width + '×' + height : '',
        bitrate: Number(item.bitrate) || 0
      });
    });

    formats.sort(function (a, b) {
      return b.width * b.height - a.width * a.height || b.bitrate - a.bitrate;
    });
    return formats;
  }

  function normalizeFromFx(json) {
    if (!json || json.code !== 200 || !json.tweet) return null;
    var t = json.tweet;
    var author = t.author || {};
    var videos = [];

    (t.media && t.media.videos ? t.media.videos : []).forEach(function (v) {
      var formats = buildFormats(v.variants, v.formats, v.url, v.width, v.height);
      if (!formats.length) return;
      videos.push({
        id: String(v.id || ''),
        type: v.type === 'gif' ? 'gif' : 'video',
        thumbnail: v.thumbnail_url || '',
        duration: Number(v.duration) || 0,
        width: Number(v.width) || 0,
        height: Number(v.height) || 0,
        formats: formats
      });
    });

    return {
      id: String(t.id || ''),
      url: t.url || 'https://x.com/' + (author.screen_name || 'i') + '/status/' + t.id,
      text: t.text || '',
      createdAt: t.created_timestamp ? Number(t.created_timestamp) * 1000 : null,
      lang: t.lang || '',
      author: {
        name: author.name || author.screen_name || '',
        screenName: author.screen_name || '',
        avatar: author.avatar_url || '',
        followers: Number(author.followers) || 0
      },
      stats: {
        likes: Number(t.likes) || 0,
        retweets: Number(t.retweets) || 0,
        replies: Number(t.replies) || 0,
        views: Number(t.views) || 0
      },
      videos: videos
    };
  }

  function normalizeFromVx(json) {
    if (!json || !json.tweetURL) return null;
    var videos = [];

    (json.media_extended || []).forEach(function (m) {
      if (m.type !== 'video' && m.type !== 'gif') return;
      var formats = buildFormats(null, null, m.url, m.size && m.size.width, m.size && m.size.height);
      if (!formats.length) return;
      videos.push({
        id: String(m.id_str || ''),
        type: m.type === 'gif' ? 'gif' : 'video',
        thumbnail: m.thumbnail_url || '',
        duration: Number(m.duration_millis) ? Number(m.duration_millis) / 1000 : 0,
        width: Number(m.size && m.size.width) || 0,
        height: Number(m.size && m.size.height) || 0,
        formats: formats
      });
    });

    return {
      id: String(json.conversationID || ''),
      url: 'https://x.com/' + (json.user_screen_name || 'i') + '/status/' + (json.conversationID || ''),
      text: json.text || '',
      createdAt: json.date_epoch ? Number(json.date_epoch) * 1000 : null,
      lang: json.lang || '',
      author: {
        name: json.user_name || json.user_screen_name || '',
        screenName: json.user_screen_name || '',
        avatar: json.user_profile_image_url || '',
        followers: 0
      },
      stats: {
        likes: Number(json.likes) || 0,
        retweets: Number(json.retweets) || 0,
        replies: Number(json.replies) || 0,
        views: 0
      },
      videos: videos
    };
  }

  var SOURCES = [
    {
      name: 'fxtwitter',
      build: function (id) { return 'https://api.fxtwitter.com/status/' + id; },
      parse: normalizeFromFx
    },
    {
      name: 'vxtwitter',
      build: function (id) { return 'https://api.vxtwitter.com/status/' + id; },
      parse: normalizeFromVx
    }
  ];

  function fetchWithTimeout(url, timeout, signal) {
    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, timeout);
    if (signal) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener('abort', function () { controller.abort(); });
    }
    return fetch(url, {
      signal: controller.signal,
      cache: 'no-store',
      headers: { Accept: 'application/json' }
    }).then(
      function (res) {
        clearTimeout(timer);
        return res;
      },
      function (err) {
        clearTimeout(timer);
        throw err;
      }
    );
  }

  async function fetchTweet(id, signal) {
    var lastMessage = '解析失败，请稍后重试';

    for (var i = 0; i < SOURCES.length; i++) {
      var source = SOURCES[i];
      try {
        var res = await fetchWithTimeout(source.build(id), 15000, signal);
        if (!res.ok) {
          lastMessage = '解析接口返回 ' + res.status + '，请稍后重试';
          continue;
        }
        var json = await res.json();
        var tweet = source.parse(json);
        if (tweet) {
          if (!tweet.id) tweet.id = id;
          return tweet;
        }
        lastMessage = '该推文不存在、已被删除或受保护';
      } catch (err) {
        if (err && err.name === 'AbortError') throw err;
        lastMessage = navigator.onLine ? '解析服务暂时不可用，请稍后重试' : '当前网络已断开，请检查网络';
      }
    }

    throw new Error(lastMessage);
  }

  /* ------------------------------------------------------------------ */
  /* 界面渲染                                                             */
  /* ------------------------------------------------------------------ */

  function setLoading(loading) {
    state.loading = loading;
    els.parseBtn.classList.toggle('is-loading', loading);
    els.parseBtn.disabled = loading;
    els.input.disabled = loading;
  }

  function setStatus(type, message) {
    if (!type) {
      els.status.hidden = true;
      els.status.innerHTML = '';
      return;
    }
    var icon =
      type === 'error'
        ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16.5v.5"/></svg>'
        : type === 'warn'
          ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3l9 16H3L12 3z"/><path d="M12 9v4M12 16.5v.5"/></svg>'
          : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.5"/></svg>';
    els.status.hidden = false;
    els.status.className = 'status status-' + type;
    els.status.innerHTML =
      '<span class="status-icon">' + icon + '</span><span class="status-text">' + escapeHtml(message) + '</span>';
  }

  function renderSkeleton() {
    els.result.innerHTML =
      '<div class="skeleton-card">' +
      '<div class="skeleton-head"><span class="sk sk-avatar"></span><div class="sk-lines"><span class="sk sk-line w40"></span><span class="sk sk-line w25"></span></div></div>' +
      '<span class="sk sk-line w90"></span><span class="sk sk-line w70"></span>' +
      '<div class="skeleton-video"><span class="sk sk-thumb"></span><div class="sk-lines"><span class="sk sk-line w60"></span><span class="sk sk-line w40"></span><span class="sk sk-line w80"></span></div></div>' +
      '</div>';
  }

  function avatarMarkup(tweet) {
    var initial = escapeHtml((tweet.author.name || tweet.author.screenName || 'X').slice(0, 1).toUpperCase());
    var name = escapeHtml(tweet.author.name || tweet.author.screenName);
    var handle = tweet.author.screenName ? '@' + escapeHtml(tweet.author.screenName) : '';
    var avatar = tweet.author.avatar
      ? '<img class="avatar-img" src="' + escapeHtml(tweet.author.avatar) + '" data-src="' + escapeHtml(tweet.author.avatar) + '" alt="' + name + '" referrerpolicy="no-referrer" />'
      : '<span class="avatar-fallback">' + initial + '</span>';
    return (
      '<a class="avatar" href="' + escapeHtml(tweet.url) + '" target="_blank" rel="noopener noreferrer">' +
      avatar +
      '</a>' +
      '<div class="author-meta">' +
      '<div class="author-name">' + name + '</div>' +
      '<div class="author-sub"><span class="handle">' + handle + '</span>' +
      (tweet.createdAt ? '<span class="sep">·</span><span>' + escapeHtml(formatDate(tweet.createdAt)) + '</span>' : '') +
      '</div></div>'
    );
  }

  function statsMarkup(tweet) {
    var items = [];
    if (tweet.stats.replies) items.push(['回复', formatCount(tweet.stats.replies)]);
    if (tweet.stats.retweets) items.push(['转推', formatCount(tweet.stats.retweets)]);
    if (tweet.stats.likes) items.push(['喜欢', formatCount(tweet.stats.likes)]);
    if (tweet.stats.views) items.push(['查看', formatCount(tweet.stats.views)]);
    if (!items.length) return '';
    return (
      '<div class="tweet-stats">' +
      items
        .map(function (item) {
          return '<span class="stat"><b>' + item[1] + '</b>' + item[0] + '</span>';
        })
        .join('')
      +
      '</div>'
    );
  }

  function videoMarkup(video, index, tweet) {
    var formats = video.formats;
    var poster = video.thumbnail
      ? '<img class="thumb-img" src="' + escapeHtml(video.thumbnail) + '" data-src="' + escapeHtml(video.thumbnail) + '" alt="视频封面" referrerpolicy="no-referrer" loading="lazy" />'
      : '<div class="thumb-placeholder"></div>';

    var options = formats
      .map(function (f, i) {
        var bits = [f.label];
        if (f.resolution) bits.push(f.resolution);
        if (f.bitrate) bits.push(formatMbps(f.bitrate));
        return '<option value="' + i + '"' + (i === 0 ? ' selected' : '') + '>' + escapeHtml(bits.join(' · ')) + '</option>';
      })
      .join('');

    var first = formats[0];
    var firstBits = [first.label, first.resolution, formatMbps(first.bitrate)].filter(Boolean);

    return (
      '<article class="video-card" data-video-index="' + index + '">' +
      '<div class="video-thumb" data-action="preview" role="button" tabindex="0" aria-label="预览视频">' +
      poster +
      '<span class="thumb-shade"></span>' +
      '<span class="badge badge-duration">' + formatDuration(video.duration) + '</span>' +
      '<span class="badge badge-type">' + (video.type === 'gif' ? 'GIF' : '视频') + '</span>' +
      '<span class="play-btn" aria-hidden="true"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.5v13l11-6.5L8 5.5z"/></svg></span>' +
      '</div>' +
      '<div class="video-body">' +
      '<div class="video-title"><span class="live-dot"></span>视频 ' + (index + 1) + ' · 共 ' + formats.length + ' 种画质</div>' +
      '<div class="field"><label for="quality-' + index + '">清晰度</label>' +
      '<div class="select-wrap"><select id="quality-' + index + '" class="quality-select" data-role="quality">' + options + '</select>' +
      '<svg class="select-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6"/></svg></div></div>' +
      '<div class="file-meta" data-role="meta">' + escapeHtml(firstBits.join(' · ')) + '</div>' +
      '<div class="video-actions">' +
      '<a class="download-btn" data-action="download" href="' + escapeHtml(first.url) + '" download="' + escapeHtml(safeFileName('', 'twitter-video')) + '" rel="noopener noreferrer">' +
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12M7 11l5 5 5-5"/><path d="M4 20h16"/></svg>' +
      '<span class="download-label">下载视频</span></a>' +
      '<button type="button" class="secondary-btn" data-action="copy">复制直链</button>' +
      '</div>' +
      '<div class="progress" data-role="progress" hidden><div class="progress-bar" data-role="bar"></div><span class="progress-text" data-role="progress-text">0%</span></div>' +
      '</div></article>'
    );
  }

  function render(tweet) {
    var content = '';

    content +=
      '<div class="tweet-card">' +
      '<div class="tweet-head">' +
      avatarMarkup(tweet) +
      '<a class="tweet-link" href="' + escapeHtml(tweet.url) + '" target="_blank" rel="noopener noreferrer">查看原推文' +
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 17L17 7M9 7h8v8"/></svg></a>' +
      '</div>';

    if (tweet.text) {
      content += '<p class="tweet-text">' + escapeHtml(tweet.text) + '</p>';
    }
    content += statsMarkup(tweet);
    content += '</div>';

    if (tweet.videos.length) {
      content +=
        '<div class="result-head"><h2>可用视频 <span class="count">' + tweet.videos.length + '</span></h2>' +
        '<span class="result-hint">选择画质后下载</span></div>' +
        '<div class="video-list">' +
        tweet.videos
          .map(function (video, i) {
            return videoMarkup(video, i, tweet);
          })
          .join('') +
        '</div>';
    } else {
      content +=
        '<div class="no-video"><span class="no-video-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="3" y="6" width="18" height="12" rx="3"/><path d="M10 9.5l5 2.5-5 2.5z"/></svg></span>' +
        '<div><b>没有找到视频</b><p>这条推文可能只包含图片、文字，或视频已被删除。</p></div></div>';
    }

    els.result.innerHTML = content;
    els.result.classList.remove('is-visible');
    void els.result.offsetWidth;
    els.result.classList.add('is-visible');

    $$('.video-card', els.result).forEach(bindVideoCard);
  }

  function buildDownloadFilename(tweet, videoIndex, format) {
    return safeFileName(
      tweet.author.screenName + '-' + tweet.id + (tweet.videos.length > 1 ? '-' + (videoIndex + 1) : '') + '-' + format.label,
      'twitter-video'
    );
  }

  function bindVideoCard(card) {
    var select = $('[data-role="quality"]', card);
    var meta = $('[data-role="meta"]', card);
    var downloadBtn = $('[data-action="download"]', card);
    var index = Number(card.dataset.videoIndex);

    function currentFormat() {
      var tweet = state.tweet;
      var video = tweet && tweet.videos[index];
      if (!video) return null;
      return video.formats[Number(select.value)] || video.formats[0];
    }

    function syncMeta() {
      var format = currentFormat();
      if (!format) return;
      var bits = [format.label, format.resolution, formatMbps(format.bitrate)].filter(Boolean);
      meta.textContent = bits.join(' · ');
      // 同步下载链接
      if (downloadBtn) {
        var tweet = state.tweet;
        downloadBtn.href = format.url;
        if (tweet) downloadBtn.setAttribute('download', buildDownloadFilename(tweet, index, format));
      }
    }

    select.addEventListener('change', syncMeta);
    // 初始同步一次 download 属性（拿到真实 tweet 数据后）
    if (state.tweet) syncMeta(); else setTimeout(syncMeta, 0);

    // 桌面端点击拦截：阻止默认跳转，走 fetch+Blob 保存（弹出"另存为"对话框，文件名可控）
    // 移动端长按：不拦截，浏览器看到 <a href> 直接弹出原生"下载链接"菜单
    downloadBtn.addEventListener('click', function (e) {
      var format = currentFormat();
      if (!format || !state.tweet) return;
      e.preventDefault();
      downloadVideo(downloadBtn, index, format);
    });

    $('[data-action="copy"]', card).addEventListener('click', function () {
      var format = currentFormat();
      if (!format) return;
      copyText(format.url).then(
        function () { showToast('直链已复制到剪贴板'); },
        function () { showToast('复制失败，请手动选择链接', 'error'); }
      );
    });

    var thumb = $('[data-action="preview"]', card);
    function openByKeyboard(e) {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        openPreview(index);
      }
    }
    thumb.addEventListener('click', function () { openPreview(index); });
    thumb.addEventListener('keydown', openByKeyboard);
  }

  /* ------------------------------------------------------------------ */
  /* 下载                                                                 */
  /* ------------------------------------------------------------------ */

  function updateProgress(card, ratio, received) {
    var wrap = $('[data-role="progress"]', card);
    var bar = $('[data-role="bar"]', card);
    var text = $('[data-role="progress-text"]', card);
    var label = $('.download-label', card);
    if (!wrap) return;
    wrap.hidden = false;
    if (ratio != null) {
      var percent = Math.min(100, Math.round(ratio * 100));
      bar.style.width = percent + '%';
      bar.classList.remove('is-indeterminate');
      text.textContent = percent + '%';
      if (label) label.textContent = '下载中 ' + percent + '%';
    } else {
      bar.style.width = '35%';
      bar.classList.add('is-indeterminate');
      text.textContent = (received / 1048576).toFixed(1) + ' MB';
      if (label) label.textContent = '下载中…';
    }
  }

  function resetProgress(card) {
    var wrap = $('[data-role="progress"]', card);
    var bar = $('[data-role="bar"]', card);
    var label = $('.download-label', card);
    if (wrap) wrap.hidden = true;
    if (bar) {
      bar.style.width = '0%';
      bar.classList.remove('is-indeterminate');
    }
    if (label) label.textContent = '下载视频';
  }

  async function fetchVideoBlob(url, onProgress) {
    var res = await fetch(url, {
      cache: 'no-store',
      referrerPolicy: 'no-referrer'
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);

    var type = (res.headers.get('content-type') || '').toLowerCase();
    var typeOk =
      !type ||
      type.indexOf('video/') === 0 ||
      type.indexOf('application/octet-stream') === 0 ||
      type.indexOf('application/mp4') === 0;
    if (!typeOk) throw new Error('中转服务返回异常内容');

    var total = Number(res.headers.get('content-length')) || 0;

    if (!res.body || !res.body.getReader) {
      var blob = await res.blob();
      if (!blob.size) throw new Error('返回内容为空');
      onProgress(1);
      return blob;
    }

    var reader = res.body.getReader();
    var chunks = [];
    var received = 0;
    while (true) {
      var step = await reader.read();
      if (step.done) break;
      chunks.push(step.value);
      received += step.value.length;
      onProgress(total ? received / total : null, received);
    }
    if (!received) throw new Error('返回内容为空');
    return new Blob(chunks, { type: 'video/mp4' });
  }

  function saveBlobAsFile(blob, filename) {
    // 关键：blob URL 是同源的，<a download> 一定会生效 → 浏览器弹出保存对话框
    var objectUrl = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = objectUrl;
    a.download = filename;
    a.rel = 'noopener noreferrer';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    // 给浏览器足够时间弹出对话框后释放
    setTimeout(function () { URL.revokeObjectURL(objectUrl); }, 30000);
  }

  async function downloadVideo(btn, videoIndex, format) {
    if (btn.classList.contains('is-busy') || !state.tweet) return;
    var card = btn.closest('.video-card');
    var filename = buildDownloadFilename(state.tweet, videoIndex, format);

    btn.classList.add('is-busy');
    resetProgress(card);
    updateProgress(card, 0, 0);

    try {
      var blob = await fetchVideoBlob(format.url, function (ratio, received) {
        updateProgress(card, ratio, received);
      });
      resetProgress(card);
      saveBlobAsFile(blob, filename);
      showToast('已弹出保存对话框 · ' + Math.max(1, Math.round(blob.size / 1048576)) + ' MB');
    } catch (err) {
      resetProgress(card);
      showToast(
        '下载失败' + (err && err.message ? '（' + escapeHtml(err.message) + '）' : '') +
          '，可尝试<a href="' + escapeHtml(format.url) + '" target="_blank" rel="noopener noreferrer">直接打开视频</a>。',
        'error',
        8000
      );
    } finally {
      btn.classList.remove('is-busy');
    }
  }

  /* ------------------------------------------------------------------ */
  /* 预览                                                                 */
  /* ------------------------------------------------------------------ */

  function openPreview(videoIndex) {
    var tweet = state.tweet;
    if (!tweet || !tweet.videos[videoIndex]) return;
    var video = tweet.videos[videoIndex];
    var card = $('.video-card[data-video-index="' + videoIndex + '"]', els.result);
    var select = card ? $('[data-role="quality"]', card) : null;
    var format = video.formats[Number(select && select.value) || 0];

    els.previewTitle.textContent = (video.type === 'gif' ? 'GIF 预览' : '视频预览') + ' · ' + format.label;
    els.previewBody.innerHTML =
      '<video id="preview-video" controls autoplay playsinline ' +
      (video.thumbnail ? 'poster="' + escapeHtml(video.thumbnail) + '" ' : '') +
      'src="' + escapeHtml(format.url) + '"></video>' +
      '<p class="preview-error" id="preview-error" hidden></p>';
    els.previewFoot.innerHTML =
      '<span class="preview-meta">' + escapeHtml([format.label, format.resolution, formatMbps(format.bitrate)].filter(Boolean).join(' · ')) + '</span>' +
      '<a class="preview-link" href="' + escapeHtml(format.url) + '" target="_blank" rel="noopener noreferrer">在新窗口打开</a>';

    els.overlay.classList.remove('hidden');
    els.overlay.setAttribute('aria-hidden', 'false');
    document.body.classList.add('no-scroll');

    var player = $('#preview-video', els.previewBody);
    var errorBox = $('#preview-error', els.previewBody);

    player.addEventListener('error', function () {
      errorBox.hidden = false;
      errorBox.innerHTML =
        '浏览器无法加载该视频，可在<a href="' +
        escapeHtml(format.url) +
        '" target="_blank" rel="noopener noreferrer">新窗口打开原视频</a>。';
    });
  }

  function closePreview() {
    els.overlay.classList.add('hidden');
    els.overlay.setAttribute('aria-hidden', 'true');
    els.previewBody.innerHTML = '';
    els.previewFoot.innerHTML = '';
    document.body.classList.remove('no-scroll');
  }

  /* ------------------------------------------------------------------ */
  /* 收款码弹层                                                           */
  /* ------------------------------------------------------------------ */

  var QRCODE_LABELS = {
    wechat: '微信收款码',
    alipay: '支付宝收款码'
  };

  function onQrcodeImgError(img) {
    img.style.background = 'rgba(255,255,255,0.04)';
    img.alt = '请将收款码图片放到 assets/ 目录下';
  }

  function openQrcode(type) {
    var title = QRCODE_LABELS[type] || '收款码';
    var imgSrc = type === 'wechat' ? './assets/qrcode-wechat.png' : './assets/qrcode-alipay.png';

    var overlay = document.createElement('div');
    overlay.className = 'qrcode-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', title);
    overlay.innerHTML =
      '<div class="qrcode-backdrop" data-close="1"></div>' +
      '<div class="qrcode-modal">' +
      '<button type="button" class="icon-btn qrcode-close" aria-label="关闭">' +
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>' +
      '</button>' +
      '<div class="qrcode-img-wrap">' +
      '<img class="qrcode-img qrcode-modal-img" src="' + imgSrc + '" alt="' + title + '" />' +
      '</div>' +
      '<span class="qrcode-modal-title">' + title + '</span>' +
      '</div>';

    overlay.addEventListener('click', function (e) {
      if (e.target.dataset.close === '1') closeQrcode();
    });

    var closeBtn = overlay.querySelector('.qrcode-close');
    if (closeBtn) closeBtn.addEventListener('click', closeQrcode);

    var modalImg = overlay.querySelector('.qrcode-modal-img');
    if (modalImg) modalImg.addEventListener('error', function () { onQrcodeImgError(modalImg); });

    document.body.appendChild(overlay);
    document.body.classList.add('no-scroll');
    state.qrcodeOverlay = overlay;
  }

  function closeQrcode() {
    var overlay = state.qrcodeOverlay;
    if (!overlay) return;
    document.body.removeChild(overlay);
    document.body.classList.remove('no-scroll');
    state.qrcodeOverlay = null;
  }

  /* ------------------------------------------------------------------ */
  /* 提示                                                                 */
  /* ------------------------------------------------------------------ */

  var toastTimer = null;

  function showToast(message, type, duration) {
    clearTimeout(toastTimer);
    els.toast.className = 'toast' + (type === 'error' ? ' toast-error' : '');
    els.toast.innerHTML =
      '<span class="toast-icon">' +
      (type === 'error'
        ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16.5v.5"/></svg>'
        : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 6L9 17l-5-5"/></svg>') +
      '</span><span class="toast-text">' + message + '</span>';
    els.toast.hidden = false;
    requestAnimationFrame(function () { els.toast.classList.add('show'); });
    toastTimer = setTimeout(function () {
      els.toast.classList.remove('show');
      setTimeout(function () { els.toast.hidden = true; }, 260);
    }, duration || 3200);
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text);
    }
    return new Promise(function (resolve, reject) {
      var textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      try {
        var ok = document.execCommand('copy');
        document.body.removeChild(textarea);
        ok ? resolve() : reject(new Error('copy failed'));
      } catch (err) {
        document.body.removeChild(textarea);
        reject(err);
      }
    });
  }

  /* ------------------------------------------------------------------ */
  /* 主流程                                                               */
  /* ------------------------------------------------------------------ */

  async function parse(rawValue) {
    var raw = (rawValue != null ? rawValue : els.input.value).trim();
    if (!raw) {
      setStatus('error', '请先粘贴 Twitter / X 推文链接');
      els.input.focus();
      return;
    }

    var id = extractTweetId(raw);
    if (!id) {
      setStatus('error', '没有识别到推文 ID，请粘贴形如 https://x.com/user/status/1234567890 的链接');
      els.input.focus();
      return;
    }

    if (state.controller) state.controller.abort();
    var controller = new AbortController();
    state.controller = controller;

    state.lastInput = raw;
    setStatus(null);
    setLoading(true);
    renderSkeleton();

    try {
      var tweet = await fetchTweet(id, controller.signal);
      state.tweet = tweet;
      render(tweet);
      if (!tweet.videos.length) {
        setStatus('warn', '解析成功，但这条推文没有可下载的视频');
      }
    } catch (err) {
      if (err && err.name === 'AbortError') return;
      setStatus('error', err && err.message ? err.message : '解析失败，请稍后重试');
      els.result.innerHTML = '';
      els.result.classList.remove('is-visible');
      state.tweet = null;
    } finally {
      if (state.controller === controller) {
        setLoading(false);
        state.controller = null;
      }
    }
  }

  function syncClearButton() {
    els.clearBtn.hidden = !els.input.value;
  }

  /* ------------------------------------------------------------------ */
  /* 事件绑定                                                             */
  /* ------------------------------------------------------------------ */

  els.form.addEventListener('submit', function (e) {
    e.preventDefault();
    parse();
  });

  els.input.addEventListener('input', syncClearButton);

  els.input.addEventListener('paste', function (event) {
    var text = event.clipboardData && event.clipboardData.getData('text');
    if (!text) return;
    var id = extractTweetId(text);
    if (id && text.trim() !== id) {
      event.preventDefault();
      els.input.value = text.trim();
      syncClearButton();
      parse(els.input.value);
    }
  });

  els.pasteBtn.addEventListener('click', function () {
    if (!navigator.clipboard || !navigator.clipboard.readText) {
      showToast('当前浏览器不支持读取剪贴板，请手动粘贴', 'error');
      els.input.focus();
      return;
    }
    navigator.clipboard.readText().then(
      function (text) {
        if (!text) {
          showToast('剪贴板是空的', 'error');
          return;
        }
        els.input.value = text.trim();
        syncClearButton();
        parse(els.input.value);
      },
      function () {
        showToast('无法读取剪贴板，请手动粘贴链接', 'error');
        els.input.focus();
      }
    );
  });

  els.clearBtn.addEventListener('click', function () {
    els.input.value = '';
    state.tweet = null;
    els.result.innerHTML = '';
    els.result.classList.remove('is-visible');
    setStatus(null);
    syncClearButton();
    els.input.focus();
  });

  els.examples.addEventListener('click', function (e) {
    var chip = e.target.closest('.example-chip');
    if (!chip) return;
    els.input.value = chip.dataset.url;
    syncClearButton();
    parse(chip.dataset.url);
  });

  els.previewClose.addEventListener('click', closePreview);

  els.overlay.addEventListener('click', function (e) {
    if (e.target.dataset.close === '1') closePreview();
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !els.overlay.classList.contains('hidden')) {
      closePreview();
    } else if (e.key === 'Escape' && state.qrcodeOverlay) {
      closeQrcode();
    }
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      parse();
    }
  });

  window.addEventListener('online', function () { showToast('网络已恢复'); });
  window.addEventListener('offline', function () { showToast('网络已断开', 'error'); });

  // 支持 ?url=xxx 直接解析
  (function init() {
    var params = new URLSearchParams(window.location.search);
    var url = params.get('url');
    if (url) {
      els.input.value = url;
      syncClearButton();
      parse(url);
    }
    syncClearButton();

    // 收款码卡片点击（事件委托）
    document.addEventListener('click', function (e) {
      var card = e.target.closest('.qrcode-card');
      if (card) {
        openQrcode(card.dataset.qrcode);
      }
    });

    // 静态收款码图片加载错误处理
    $$('[data-qrcode-img]').forEach(function (img) {
      img.addEventListener('error', function () { onQrcodeImgError(img); });
    });
  })();
})();
