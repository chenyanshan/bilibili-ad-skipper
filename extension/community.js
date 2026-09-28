export const COMMUNITY_ORIGIN = 'https://www.bsbsb.top';
export const COMMUNITY_PROJECT_URL = 'https://github.com/hanydd/BilibiliSponsorBlock';
const CACHE_KEY = 'community:cache';
const USER_KEY = 'community:userID';
const ATTEMPTS_KEY = 'community:attempts';
const HOUR = 3600000;
const WEEK = 7 * 24 * HOUR;
const queues = new WeakMap();
const unavailable = () => ({status:'unavailable', hasAd:false, segments:[], message:'社区查询暂不可用，请稍后重试'});
const submitError = () => ({status:'error', message:'投稿未确认成功，已保留本地片段'});

function serial(storage, action) {
  const previous = queues.get(storage) || Promise.resolve();
  const next = previous.catch(() => {}).then(action);
  queues.set(storage, next);
  return next;
}
function snapshotVideo(video) {
  const result = {bvid:video?.bvid, cid:String(video?.cid ?? ''), duration:video?.duration};
  if (!/^BV[0-9A-Za-z]{10}$/.test(result.bvid || '') || !/^[1-9][0-9]*$/.test(result.cid) ||
      !Number.isFinite(result.duration) || result.duration <= 0) throw Error('Invalid video');
  return result;
}
function validRange(start, end, duration) {
  return Number.isFinite(start) && Number.isFinite(end) && start >= 0 && end > start && end <= duration;
}
function probability(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}
function videoKey(video) { return `${video.bvid}:${video.cid}`; }
function sameRange(a, b) { return a.start < b.end && b.start < a.end; }

export function createCommunityClient({fetch, storage, now = Date.now, version}) {
  if (typeof fetch !== 'function' || !storage || typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version)) {
    throw Error('Invalid community client configuration');
  }
  async function request(path, options = {}) {
    const url = new URL(path, COMMUNITY_ORIGIN);
    if (url.origin !== COMMUNITY_ORIGIN || !url.pathname.startsWith('/api/')) throw Error('Invalid endpoint');
    const response = await fetch(url.href, {
      ...options, credentials:'omit', redirect:'error', signal:AbortSignal.timeout(25000),
    });
    return response;
  }
  async function readJson(response) {
    const text = await response.text();
    if (text.length > 4_000_000) throw Error('Response too large');
    return JSON.parse(text);
  }
  async function writeCache(video, result) {
    const saved = (await storage.get(CACHE_KEY))[CACHE_KEY];
    const records = Array.isArray(saved) ? saved.filter(record => record && record.key !== videoKey(video) &&
      Number.isFinite(record.time) && record.time <= now() && now() - record.time < HOUR) : [];
    records.push({key:videoKey(video), duration:video.duration, time:now(), result});
    await storage.set({[CACHE_KEY]:records.slice(-100)});
  }
  function parseLookup(payload, video) {
    if (!Array.isArray(payload)) throw Error('Invalid community response');
    let hasAd = false, hasFullVideoAd = false;
    const segments = [];
    for (const entry of payload) {
      if (!entry || typeof entry.videoID !== 'string' || !Array.isArray(entry.segments)) throw Error('Invalid community response');
      if (entry.videoID !== video.bvid) continue;
      for (const item of entry.segments) {
        if (!item || !/^[1-9][0-9]*$/.test(String(item.cid ?? '')) || typeof item.category !== 'string' || typeof item.actionType !== 'string') {
          throw Error('Invalid community segment');
        }
        if (String(item.cid) !== video.cid || item.category !== 'sponsor') continue;
        hasAd = true;
        if (item.actionType === 'full') hasFullVideoAd = true;
        if (item.actionType !== 'skip' || !Array.isArray(item.segment) || item.segment.length !== 2 ||
            !validRange(item.segment[0], item.segment[1], video.duration) ||
            typeof item.UUID !== 'string' || !item.UUID || item.UUID.length > 256 ||
            (item.videoDuration != null && item.videoDuration !== 0 &&
              (!Number.isFinite(item.videoDuration) || Math.abs(item.videoDuration - video.duration) > 2))) continue;
        if (!segments.some(segment => segment.id === item.UUID)) {
          segments.push({id:item.UUID, start:item.segment[0], end:item.segment[1], source:'community', reason:'社区标注的付费广告'});
        }
      }
    }
    return {status:hasAd ? 'found' : 'empty', hasAd, segments:segments.sort((a,b) => a.start-b.start), hasFullVideoAd};
  }
  async function lookup(input, {force = false} = {}) {
    try {
      const video = snapshotVideo(input);
      if (!force) {
        const records = (await storage.get(CACHE_KEY))[CACHE_KEY];
        const cached = Array.isArray(records) && records.find(record => record?.key === videoKey(video) &&
          record.duration === video.duration && Number.isFinite(record.time) && record.time <= now() &&
          now() - record.time < HOUR && ['found','empty'].includes(record.result?.status));
        if (cached) return structuredClone(cached.result);
      }
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(video.bvid));
      const prefix = [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2,'0')).join('').slice(0,4);
      const response = await request(`/api/skipSegments/${prefix}`, force ? {headers:{'X-SKIP-CACHE':'1', 'Cache-Control':'no-cache'}} : {});
      let result;
      if (response.status === 404) result = {status:'empty', hasAd:false, segments:[], hasFullVideoAd:false};
      else if (response.status === 200 && response.ok) result = parseLookup(await readJson(response), video);
      else return unavailable();
      await writeCache(video, result);
      return result;
    } catch { return unavailable(); }
  }
  async function userID() {
    let id = (await storage.get(USER_KEY))[USER_KEY];
    if (typeof id !== 'string' || !/^[0-9a-f]{64}$/.test(id)) {
      id = [...crypto.getRandomValues(new Uint8Array(32))].map(value => value.toString(16).padStart(2,'0')).join('');
      await storage.set({[USER_KEY]:id});
    }
    return id;
  }
  async function submitSnapshot(video, segment, options) {
    try {
      const {automatic, provider, isCurrent} = options;
      if (!validRange(segment.start, segment.end, video.duration) || segment.truncated ||
          (automatic && (provider !== 'jev' || !segment.autoSubmitEligible ||
            !probability(segment.confidence) || segment.confidence < .90 ||
            !probability(segment.boundaryConfidence) || segment.boundaryConfidence < .90))) {
        return {status:'blocked', message:'该片段不符合投稿条件，请检查广告边界'};
      }
      const community = await lookup(video, {force:true});
      if (community.status === 'unavailable') return {status:'blocked', message:'无法复核社区标注，暂未投稿'};
      if (community.hasAd) return {status:'duplicate', message:'当前视频已有社区广告标注，未重复投稿'};
      const stored = (await storage.get(ATTEMPTS_KEY))[ATTEMPTS_KEY];
      if (stored !== undefined && !Array.isArray(stored)) return submitError();
      const attempts = (stored || []).filter(record => record && Number.isFinite(record.time) && record.time <= now() && now()-record.time < WEEK);
      const matching = attempts.filter(record => record.video === videoKey(video) && sameRange(record,segment));
      if (matching.some(record => record.state === 'submitted' || record.state === 'duplicate')) {
        return {status:'duplicate', message:'该广告已投稿，未重复提交'};
      }
      if (automatic && matching.length) return {status:'blocked', message:'该广告已尝试自动投稿，请手动确认后重试'};
      const id = await userID();
      const attempt = {video:videoKey(video), start:segment.start, end:segment.end, time:now(), state:'attempted'};
      const ledger = [...attempts, attempt].slice(-500);
      // Persist before sending. A failed automatic POST is never retried automatically.
      await storage.set({[ATTEMPTS_KEY]:ledger});
      if (isCurrent && await isCurrent() !== true) {
        return {status:'blocked', message:'视频或配置已变化，已停止投稿'};
      }
      const response = await request('/api/skipSegments', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body:JSON.stringify({videoID:video.bvid, cid:video.cid, userID:id, videoDuration:video.duration,
          userAgent:`bilibili-ad-skipper/${version}`, segments:[{segment:[segment.start,segment.end], category:'sponsor', actionType:'skip'}]}),
      });
      if (response.status === 409) {
        attempt.state = 'duplicate';
        await storage.set({[ATTEMPTS_KEY]:ledger});
        return {status:'duplicate', message:'社区已存在该广告，未重复提交'};
      }
      if (response.status !== 200 || !response.ok) {
        const reasons = {
          400:'投稿参数未被社区接受（HTTP 400），请检查广告边界',
          403:'社区拒绝本次投稿（HTTP 403），请手动确认',
          429:'投稿过于频繁（HTTP 429），请稍后手动重试',
        };
        return reasons[response.status] ? {status:'error', message:reasons[response.status]} : submitError();
      }
      const receipt = await readJson(response);
      const UUID = Array.isArray(receipt) && receipt.length === 1 && receipt[0]?.UUID;
      if (typeof UUID !== 'string' || !/^[A-Za-z0-9_-]{6,256}$/.test(UUID)) return submitError();
      const returned = receipt[0];
      if (('category' in returned && returned.category !== 'sponsor') ||
          ('segment' in returned && (!Array.isArray(returned.segment) || returned.segment.length !== 2 ||
            returned.segment[0] !== segment.start || returned.segment[1] !== segment.end))) return submitError();
      attempt.state = 'submitted';
      attempt.UUID = UUID;
      await storage.set({[ATTEMPTS_KEY]:ledger});
      await writeCache(video, {status:'found', hasAd:true, hasFullVideoAd:false, segments:[{
        id:UUID, start:segment.start, end:segment.end, source:'community', reason:'社区标注的付费广告',
      }]});
      return {status:'submitted', message:'已提交到社区', UUID};
    } catch { return submitError(); }
  }
  function submit(input, inputSegment, {automatic = false, provider = 'jev', isCurrent} = {}) {
    try {
      const video = snapshotVideo(input);
      // Only allowlisted scalar values survive the await boundary or reach the wire.
      const segment = {start:inputSegment?.start, end:inputSegment?.end, confidence:inputSegment?.confidence,
        boundaryConfidence:inputSegment?.boundaryConfidence, autoSubmitEligible:inputSegment?.autoSubmitEligible === true,
        truncated:inputSegment?.truncated === true};
      return serial(storage, () => submitSnapshot(video, segment, {automatic:automatic === true, provider, isCurrent}));
    } catch { return Promise.resolve(submitError()); }
  }
  return {lookup, submit};
}
