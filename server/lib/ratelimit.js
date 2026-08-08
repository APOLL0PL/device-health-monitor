function rateLimit(windowMs, limit, keyFn) {
  const hits = new Map();
  const timer = setInterval(() => hits.clear(), windowMs);
  if (timer.unref) timer.unref();
  return (req, res, next) => {
    const key = keyFn(req);
    const now = Date.now();
    const entry = hits.get(key);
    if (!entry || now - entry.start >= windowMs) {
      hits.set(key, { start: now, count: 1 });
      return next();
    }
    entry.count += 1;
    if (entry.count > limit) {
      return res.status(429).json({
        error: 'Too many requests',
        retryAfter: Math.ceil((windowMs - (now - entry.start)) / 1000),
      });
    }
    next();
  };
}

module.exports = rateLimit;
