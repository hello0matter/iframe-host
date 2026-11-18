function normalizeApiProxy(raw) {
  if (raw !== undefined && (!raw || typeof raw !== 'object' || Array.isArray(raw))) throw new Error('api_proxy: invalid configuration');
  const source = raw || {};
  for (const key of ['enabled', 'apply_request_rules', 'rewrite_request_headers']) {
    if (source[key] !== undefined && typeof source[key] !== 'boolean') throw new Error('api_proxy: invalid boolean');
  }
  const paths = source.path_prefixes === undefined ? ['/v1'] : source.path_prefixes;
  if (!Array.isArray(paths) || !paths.length || paths.length > 32 || paths.some(p => typeof p !== 'string' || p.length > 256 || !/^\/(?:[A-Za-z0-9_~.-]+\/?)*$/.test(p) || p.split('/').some(s => s === '.' || s === '..'))) throw new Error('api_proxy: invalid path prefixes');
  function seconds(key) {
    const n = source[key] === undefined ? 120 : source[key];
    if (!Number.isInteger(n) || n < 1 || n > 3600) throw new Error('api_proxy: timeout must be 1-3600 seconds');
    return n;
  }
  return {
    enabled: source.enabled === true,
    path_prefixes: [...new Set(paths.map(p => p === '/' ? p : p.replace(/\/$/, '')))],
    first_byte_timeout_seconds: seconds('first_byte_timeout_seconds'),
    idle_timeout_seconds: seconds('idle_timeout_seconds'),
    apply_request_rules: source.apply_request_rules === true,
    rewrite_request_headers: source.rewrite_request_headers === true,
  };
}

function matchesApiProxy(config, pathname) {
  return config?.enabled === true && config.path_prefixes.some(p => p === '/' || pathname === p || pathname.startsWith(p + '/'));
}

module.exports = { normalizeApiProxy, matchesApiProxy };
