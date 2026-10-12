/**
 * httpRetry.js - MISSION P1-e (extension copy)
 *
 * Axios response interceptor: on ECONNRESET / ECONNREFUSED the request is
 * retried EXACTLY ONCE, then a clear error is raised (no fake success).
 * Installed once at extension activation for the shared axios instance.
 * Idempotent. err.code is preserved so existing handlers keep working.
 *
 * NOTE: the backend holds an identical copy at backend/utils/connRetry.js
 * (separate bundle, same logic).
 * ASCII-only source (project rule).
 */
'use strict';

const RETRYABLE = { ECONNRESET: true, ECONNREFUSED: true };

function isRetryableConnError(err) {
  return !!(err && err.code && RETRYABLE[err.code]);
}

function clearConnError(err) {
  const code = (err && err.code) || 'CONN_ERROR';
  const url = (err && err.config && err.config.url) || 'unknown url';
  err.message = 'Connection lost (' + code + ') after 1 retry: ' + url;
  return err;
}

function installAxiosConnRetry(axiosInstance) {
  if (!axiosInstance || !axiosInstance.interceptors ||
      !axiosInstance.interceptors.response) return false;
  if (axiosInstance.__p1ConnRetryInstalled) return true;
  axiosInstance.interceptors.response.use(null, (err) => {
    if (err && err.config && isRetryableConnError(err) && !err.config._p1Retried) {
      err.config._p1Retried = true;
      return axiosInstance(err.config); // one retry; 2nd failure lands below
    }
    if (isRetryableConnError(err)) return Promise.reject(clearConnError(err));
    return Promise.reject(err);
  });
  axiosInstance.__p1ConnRetryInstalled = true;
  return true;
}

module.exports = { isRetryableConnError, clearConnError, installAxiosConnRetry };
