import * as Sentry from '@sentry/browser';
import { createModuleLogger, createProjectLogger } from '@metamask/utils';
import { logger } from '@sentry/utils';
import browser from 'webextension-polyfill';
import { isManifestV3 } from '../../../shared/modules/mv3.utils';
import { filterEvents } from './sentry-filter-events';
import extractEthjsErrorMessage from './extractEthjsErrorMessage';

let installType = 'unknown';

const projectLogger = createProjectLogger('sentry');

export const log = createModuleLogger(
  projectLogger,
  globalThis.document ? 'ui' : 'background',
);

const internalLog = createModuleLogger(log, 'internal');

/* eslint-disable prefer-destructuring */
// Destructuring breaks the inlining of the environment variables
const METAMASK_BUILD_TYPE = process.env.METAMASK_BUILD_TYPE;
const METAMASK_DEBUG = process.env.METAMASK_DEBUG;
const METAMASK_ENVIRONMENT = process.env.METAMASK_ENVIRONMENT;
const RELEASE = process.env.METAMASK_VERSION;
const SENTRY_DSN = process.env.SENTRY_DSN;
const SENTRY_DSN_DEV = process.env.SENTRY_DSN_DEV;
const SENTRY_DSN_MMI = process.env.SENTRY_MMI_DSN;
/* eslint-enable prefer-destructuring */

export const ERROR_URL_ALLOWLIST = {
  CRYPTOCOMPARE: 'cryptocompare.com',
  COINGECKO: 'coingecko.com',
  ETHERSCAN: 'etherscan.io',
  CODEFI: 'codefi.network',
  SEGMENT: 'segment.io',
};

function getClientOptions() {
  const environment = getSentryEnvironment();
  const sentryTarget = getSentryTarget();

  return {
    beforeBreadcrumb: beforeBreadcrumb(),
    beforeSend: (report) => rewriteReport(report),
    debug: METAMASK_DEBUG,
    dsn: sentryTarget,
    dist: isManifestV3 ? 'mv3' : 'mv2',
    environment,
    integrations: [
      Sentry.dedupeIntegration(),
      Sentry.extraErrorDataIntegration(),
      Sentry.browserTracingIntegration(),
      filterEvents({ getMetaMetricsEnabled, log }),
    ],
    release: RELEASE,
    // Client reports are automatically sent when a page's visibility changes to
    // "hidden", but cancelled (with an Error) that gets logged to the console.
    // Our test infra sometimes reports these errors as unexpected failures,
    // which results in test flakiness. We don't use these client reports, so
    // we can safely turn them off by setting the `sendClientReports` option to
    // `false`.
    sendClientReports: false,
    tracesSampleRate: 0.01,
    transport: makeTransport,
  };
}

export default function setupSentry() {
  if (!RELEASE) {
    throw new Error('Missing release');
  }

  if (!getSentryTarget()) {
    log('Skipped initialization');
    return undefined;
  }

  log('Initializing');

  integrateLogging();
  setSentryClient();

  return {
    ...Sentry,
    getMetaMetricsEnabled,
  };
}
/**
 * Returns whether MetaMetrics is enabled, given the application state.
 *
 * @param {{ state: unknown} | { persistedState: unknown }} appState - Application state
 * @returns `true` if MetaMask's state has been initialized, and MetaMetrics
 * is enabled, `false` otherwise.
 */
function getMetaMetricsEnabledFromAppState(appState) {
  // during initialization after loading persisted state
  if (appState.persistedState) {
    return getMetaMetricsEnabledFromPersistedState(appState.persistedState);
    // After initialization
  } else if (appState.state) {
    // UI
    if (appState.state.metamask) {
      return Boolean(appState.state.metamask.participateInMetaMetrics);
    }
    // background
    return Boolean(
      appState.state.MetaMetricsController?.participateInMetaMetrics,
    );
  }
  // during initialization, before first persisted state is read
  return false;
}

/**
 * Returns whether MetaMetrics is enabled, given the persisted state.
 *
 * @param {unknown} persistedState - Application state
 * @returns `true` if MetaMask's state has been initialized, and MetaMetrics
 * is enabled, `false` otherwise.
 */
function getMetaMetricsEnabledFromPersistedState(persistedState) {
  return Boolean(
    persistedState?.data?.MetaMetricsController?.participateInMetaMetrics,
  );
}

/**
 * Returns whether onboarding has completed, given the application state.
 *
 * @param {Record<string, unknown>} appState - Application state
 * @returns `true` if onboarding has completed, `false` otherwise.
 */
function getOnboardingCompleteFromAppState(appState) {
  // during initialization after loading persisted state
  if (appState.persistedState) {
    return getOnboardingCompleteFromPersistedState(appState.persistedState);
    // After initialization
  } else if (appState.state) {
    // UI
    if (appState.state.metamask) {
      return Boolean(appState.state.metamask.completedOnboarding);
    }
    // background
    return Boolean(appState.state.OnboardingController?.completedOnboarding);
  }
  // during initialization, before first persisted state is read
  return false;
}

/**
 * Returns whether onboarding has completed, given the persisted state.
 *
 * @param {Record<string, unknown>} persistedState - Persisted state
 * @returns `true` if onboarding has completed, `false` otherwise.
 */
function getOnboardingCompleteFromPersistedState(persistedState) {
  return Boolean(
    persistedState.data?.OnboardingController?.completedOnboarding,
  );
}

function getSentryEnvironment() {
  if (METAMASK_BUILD_TYPE === 'main') {
    return METAMASK_ENVIRONMENT;
  }

  return `${METAMASK_ENVIRONMENT}-${METAMASK_BUILD_TYPE}`;
}

function getSentryTarget() {
  if (METAMASK_ENVIRONMENT !== 'production') {
    return SENTRY_DSN_DEV;
  }

  if (METAMASK_BUILD_TYPE === 'mmi') {
    return SENTRY_DSN_MMI;
  }

  if (!SENTRY_DSN) {
    throw new Error(
      `Missing SENTRY_DSN environment variable in production environment`,
    );
  }

  return SENTRY_DSN;
}

/**
 * Returns whether MetaMetrics is enabled. If the application hasn't yet
 * been initialized, the persisted state will be used (if any).
 *
 * @returns `true` if MetaMetrics is enabled, `false` otherwise.
 */
async function getMetaMetricsEnabled() {
  if (METAMASK_BUILD_TYPE === 'mmi') {
    return true;
  }

  const appState = getState();

  if (appState.state || appState.persistedState) {
    return (
      getMetaMetricsEnabledFromAppState(appState) &&
      getOnboardingCompleteFromAppState(appState)
    );
  }

  // If we reach here, it means the error was thrown before initialization
  // completed, and before we loaded the persisted state for the first time.
  try {
    const persistedState = await globalThis.stateHooks.getPersistedState();
    return (
      getMetaMetricsEnabledFromPersistedState(persistedState) &&
      getOnboardingCompleteFromPersistedState(persistedState)
    );
  } catch (error) {
    log('Error retrieving persisted state', error);
    return false;
  }
}

function setSentryClient() {
  const clientOptions = getClientOptions();
  const { dsn, environment, release } = clientOptions;

  // Normally this would be awaited, but getSelf should be available by the time the report is finalized.
  // If it's not, we still get the extensionId, but the installType will default to "unknown"
  browser.management
    .getSelf()
    .then((extensionInfo) => {
      if (extensionInfo.installType) {
        installType = extensionInfo.installType;
      }
    })
    .catch((error) => {
      console.log('Error getting extension installType', error);
    });
  /**
   * Sentry throws on initialization as it wants to avoid polluting the global namespace and
   * potentially clashing with a website also using Sentry, but this could only happen in the content script.
   * This emulates NW.js which disables these validations.
   * https://docs.sentry.io/platforms/javascript/best-practices/shared-environments/
   */
  globalThis.nw = {};

  log('Updating client', {
    environment,
    dsn,
    release,
  });

  Sentry.registerSpanErrorInstrumentation();
  Sentry.init(clientOptions);

  addDebugListeners();

  return true;
}

/**
 * Receives a string and returns that string if it is a
 * regex match for a url with a `chrome-extension` or `moz-extension`
 * protocol, and an empty string otherwise.
 *
 * @param {string} url - The URL to check.
 * @returns {string} An empty string if the URL was internal, or the unmodified URL otherwise.
 */
function hideUrlIfNotInternal(url) {
  const re = /^(chrome-extension|moz-extension):\/\//u;
  if (!url.match(re)) {
    return '';
  }
  return url;
}

/**
 * Returns a method that handles the Sentry breadcrumb using a specific method to get the extension state
 *
 * @returns {(breadcrumb: object) => object} A method that modifies a Sentry breadcrumb object
 */
export function beforeBreadcrumb() {
  return (breadcrumb) => {
    if (!getState) {
      return null;
    }
    const appState = getState();
    if (
      !getMetaMetricsEnabledFromAppState(appState) ||
      !getOnboardingCompleteFromAppState(appState) ||
      breadcrumb?.category === 'ui.input'
    ) {
      return null;
    }
    const newBreadcrumb = removeUrlsFromBreadCrumb(breadcrumb);
    return newBreadcrumb;
  };
}

/**
 * Receives a Sentry breadcrumb object and potentially removes urls
 * from its `data` property, it particular those possibly found at
 * data.from, data.to and data.url
 *
 * @param {object} breadcrumb - A Sentry breadcrumb object: https://develop.sentry.dev/sdk/event-payloads/breadcrumbs/
 * @returns {object} A modified Sentry breadcrumb object.
 */
export function removeUrlsFromBreadCrumb(breadcrumb) {
  if (breadcrumb?.data?.url) {
    breadcrumb.data.url = hideUrlIfNotInternal(breadcrumb.data.url);
  }
  if (breadcrumb?.data?.to) {
    breadcrumb.data.to = hideUrlIfNotInternal(breadcrumb.data.to);
  }
  if (breadcrumb?.data?.from) {
    breadcrumb.data.from = hideUrlIfNotInternal(breadcrumb.data.from);
  }
  return breadcrumb;
}

/**
 * Receives a Sentry event object and modifies it before the
 * error is sent to Sentry. Modifications include both sanitization
 * of data via helper methods and addition of state data from the
 * return value of the second parameter passed to the function.
 *
 * @param {object} report - A Sentry event object: https://develop.sentry.dev/sdk/event-payloads/
 * @returns {object} A modified Sentry event object.
 */
export function rewriteReport(report) {
  try {
    // simplify certain complex error messages (e.g. Ethjs)
    simplifyErrorMessages(report);
    // remove urls from error message
    sanitizeUrlsFromErrorMessages(report);
    // Remove evm addresses from error message.
    // Note that this is redundent with data scrubbing we do within our sentry dashboard,
    // but putting the code here as well gives public visibility to how we are handling
    // privacy with respect to sentry.
    sanitizeAddressesFromErrorMessages(report);
    // modify report urls
    rewriteReportUrls(report);

    // append app state
    const appState = getState();

    if (!report.extra) {
      report.extra = {};
    }

    report.extra.appState = appState;

    if (browser.runtime && browser.runtime.id) {
      report.extra.extensionId = browser.runtime.id;
    }
    report.extra.installType = installType;
  } catch (err) {
    log('Error rewriting report', err);
  }
  return report;
}

/**
 * Receives a Sentry event object and modifies it so that urls are removed from any of its
 * error messages.
 *
 * @param {object} report - the report to modify
 */
function sanitizeUrlsFromErrorMessages(report) {
  rewriteErrorMessages(report, (errorMessage) => {
    let newErrorMessage = errorMessage;
    const re = /(([-.+a-zA-Z]+:\/\/)|(www\.))\S+[@:.]\S+/gu;
    const urlsInMessage = newErrorMessage.match(re) || [];
    urlsInMessage.forEach((url) => {
      try {
        const urlObj = new URL(url);
        const { hostname } = urlObj;
        if (
          !Object.values(ERROR_URL_ALLOWLIST).some(
            (allowedHostname) =>
              hostname === allowedHostname ||
              hostname.endsWith(`.${allowedHostname}`),
          )
        ) {
          newErrorMessage = newErrorMessage.replace(url, '**');
        }
      } catch (e) {
        newErrorMessage = newErrorMessage.replace(url, '**');
      }
    });
    return newErrorMessage;
  });
}

/**
 * Receives a Sentry event object and modifies it so that ethereum addresses are removed from
 * any of its error messages.
 *
 * @param {object} report - the report to modify
 */
function sanitizeAddressesFromErrorMessages(report) {
  rewriteErrorMessages(report, (errorMessage) => {
    const newErrorMessage = errorMessage.replace(/0x[A-Fa-f0-9]{40}/u, '0x**');
    return newErrorMessage;
  });
}

function simplifyErrorMessages(report) {
  rewriteErrorMessages(report, (errorMessage) => {
    // simplify ethjs error messages
    let simplifiedErrorMessage = extractEthjsErrorMessage(errorMessage);
    // simplify 'Transaction Failed: known transaction'
    if (
      simplifiedErrorMessage.indexOf(
        'Transaction Failed: known transaction',
      ) === 0
    ) {
      // cut the hash from the error message
      simplifiedErrorMessage = 'Transaction Failed: known transaction';
    }
    return simplifiedErrorMessage;
  });
}

function rewriteErrorMessages(report, rewriteFn) {
  // rewrite top level message
  if (typeof report.message === 'string') {
    report.message = rewriteFn(report.message);
  }
  // rewrite each exception message
  if (report.exception && report.exception.values) {
    report.exception.values.forEach((item) => {
      if (typeof item.value === 'string') {
        item.value = rewriteFn(item.value);
      }
    });
  }
}

function rewriteReportUrls(report) {
  if (report.request?.url) {
    // update request url
    report.request.url = toMetamaskUrl(report.request.url);
  }

  // update exception stack trace
  if (report.exception && report.exception.values) {
    report.exception.values.forEach((item) => {
      if (item.stacktrace) {
        item.stacktrace.frames.forEach((frame) => {
          frame.filename = toMetamaskUrl(frame.filename);
        });
      }
    });
  }
}

function toMetamaskUrl(origUrl) {
  if (!globalThis.location?.origin) {
    return origUrl;
  }

  const filePath = origUrl?.split(globalThis.location.origin)[1];
  if (!filePath) {
    return origUrl;
  }
  const metamaskUrl = `/metamask${filePath}`;
  return metamaskUrl;
}

function getState() {
  return globalThis.stateHooks?.getSentryState?.() || {};
}

function integrateLogging() {
  if (!METAMASK_DEBUG) {
    return;
  }

  for (const loggerType of ['log', 'error']) {
    logger[loggerType] = (...args) => {
      const message = args[0].replace(`Sentry Logger [${loggerType}]: `, '');
      internalLog(message, ...args.slice(1));
    };
  }

  log('Integrated logging');
}

function addDebugListeners() {
  if (!METAMASK_DEBUG) {
    return;
  }

  const client = Sentry.getClient();

  client?.on('beforeEnvelope', (event) => {
    if (isCompletedSessionEnvelope(event)) {
      log('Completed session', event);
    }
  });

  client?.on('afterSendEvent', (event) => {
    const type = getEventType(event);
    log(type, event);
  });

  log('Added debug listeners');
}

function makeTransport(options) {
  return Sentry.makeFetchTransport(options, async (...args) => {
    const metricsEnabled = await getMetaMetricsEnabled();

    if (!metricsEnabled) {
      throw new Error('Network request skipped as metrics disabled');
    }

    return await fetch(...args);
  });
}

function isCompletedSessionEnvelope(envelope) {
  const type = envelope?.[1]?.[0]?.[0]?.type;
  const data = envelope?.[1]?.[0]?.[1] ?? {};

  return type === 'session' && data.status === 'exited';
}

function getEventType(event) {
  if (event.type === 'transaction') {
    return 'Trace';
  }

  if (event.level === 'error') {
    return 'Error';
  }

  return 'Event';
}
