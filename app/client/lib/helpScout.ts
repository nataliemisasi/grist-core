/**
 * This module contains tools and helpers to open HelpScout "Beacon" -- a popup which may contain
 * an email form, chat, and help docs -- and to include info relevant to support requests.
 *
 * Usage:
 *    import {Beacon} from 'app/client/lib/helpScout';
 *    Beacon('open')
 *    Beacon('prefill', {...})
 * It takes care of initialization automatically.
 *
 * This is essentially a prettified typescript version of the snippet for the HelpScout Beacon
 * available under Beacon settings in HelpScout. It offers the API documented at
 * https://developer.helpscout.com/beacon-2/web/javascript-api/
 */

// tslint:disable:unified-signatures

import {AppModel, reportError} from 'app/client/models/AppModel';
import {IAppError} from 'app/client/models/NotifyModel';
import {GristLoadConfig} from 'app/common/gristUrls';
import {timeFormat} from 'app/common/timeFormat';
import {ActiveSessionInfo} from 'app/common/UserAPI';
import * as version from 'app/common/version';
import {dom} from 'grainjs';
import identity = require('lodash/identity');
import pickBy = require('lodash/pickBy');

export type BeaconCmd = 'init' | 'destroy' | 'open' | 'close' | 'toggle' | 'search' | 'suggest' |
  'article' | 'navigate' | 'identify' | 'prefill' | 'reset' | 'logout' | 'config' | 'on' | 'off' |
  'once' | 'event' | 'session-data';

export type BeaconRoute = '/ask/message/' | '/answers/';

export interface IUserObj {
  name?: string;
  email?: string;
  company?: string;
  jobTitle?: string;
  avatar?: string;
  signature?: string;
  [customKey: string]: string|number|boolean|null|undefined;
}

interface IFormObj {
  name?: string;
  email?: string;
  subject?: string;
  text?: string;
  fields?: Array<{id: number, value: string|number|boolean}>;
}

interface ISessionData {
  [key: string]: string;
}

/**
 * This provides the HelpScout Beacon API, taking care of initializing Beacon on first use.
 */
export function Beacon(method: 'init', beaconId: string): void;
export function Beacon(method: 'search', query: string): void;
export function Beacon(method: 'suggest', articles?: string[]): void;
export function Beacon(method: 'article', articleId: string, options?: unknown): void;
export function Beacon(method: 'navigate', route: string): void;
export function Beacon(method: 'identify', userObj: IUserObj): void;
export function Beacon(method: 'prefill', formObj: IFormObj): void;
export function Beacon(method: 'config', configObj: object): void;
export function Beacon(method: 'on'|'off'|'once', event: 'open'|'close', callback: () => void): void;
export function Beacon(method: 'session-data', data: ISessionData): void;
export function Beacon(method: BeaconCmd): void;
export function Beacon(method: BeaconCmd, options?: unknown, data?: unknown) {
  initBeacon();
  (window as any).Beacon(method, options, data);
}

// This is essentially what's done by the code snippet that HelpScout suggests to install in every
// page. In Grist app pages, we only load HelpScout code when the beacon is opened.
function _beacon(method: BeaconCmd, options?: unknown, data?: unknown) {
  _beacon.readyQueue.push({method, options, data});
}
_beacon.readyQueue = [] as unknown[];

function initBeacon(): void {
  if (!(window as any).Beacon) {
    const gristConfig: GristLoadConfig|undefined = (window as any).gristConfig;
    const beaconId = gristConfig && gristConfig.helpScoutBeaconId;
    if (beaconId) {
      (window as any).Beacon = _beacon;
      document.head.appendChild(dom('script', {
        type: 'text/javascript',
        src: 'https://beacon-v2.helpscout.net',
        async: true,
      }));
      _beacon('init', beaconId);
      _beacon('config', {display: {style: "manual"}});
    } else {
      (window as any).Beacon = () => null;
      reportError(new Error("Support form is not configured"));
    }
  }
}

let lastOpenType: 'error' | 'message' = 'message';

/**
 * Helper to open a beacon, taking care of setting focus appropriately. Calls optional onOpen
 * callback when the beacon has opened.
 * If errors is given, prepares a form for submitting an error report, and includes stack traces
 * into the session-data.
 */
function _beaconOpen(userObj: IUserObj|null, options: IBeaconOpenOptions) {
  const {onOpen, errors} = options;

  // The beacon remembers its content, so reset it when switching between reporting errors and
  // sending a message.
  const openType = errors?.length ? 'error' : 'message';
  if (openType !== lastOpenType) {
    Beacon('reset');
    lastOpenType = openType;
  }

  Beacon('once', 'open', () => {
    const iframe = document.querySelector('#beacon-container iframe') as HTMLIFrameElement;
    if (iframe) { iframe.focus(); }
    if (onOpen) { onOpen(); }
  });
  Beacon('once', 'article-viewed' as any, () => {
    // HelpScout creates an iframe with an empty 'src' attribute, then writes to it. In such an
    // iframe, different browsers interpret relative links differently: Chrome's are relative to
    // the parent page's URL; Firefox's are relative to the parent page's <base href>.
    //
    // Here we set a <base href> explicitly in the iframe to get consistent behavior of links
    // relative to the top page's URL (HelpScout then seems to handle clicks on them correctly).
    const iframe = document.querySelector('#beacon-container iframe') as HTMLIFrameElement;
    iframe?.contentDocument?.head.appendChild(dom('base', {href: ''}));
  });
  Beacon('once', 'close', () => {
    const iframe = document.querySelector('#beacon-container iframe') as HTMLIFrameElement;
    if (iframe) { iframe.blur(); }
  });
  if (userObj) {
    Beacon('identify', userObj);
  }

  const attrs: ISessionData = {};
  let route: BeaconRoute;
  if (errors?.length) {
    // If sending errors, prefill part of the message (the user sees this and can add to it), and
    // include more detailed errors with stack traces into session-data.
    const messages = errors.map(({error, timestamp}) =>
      (timeFormat('T', new Date(timestamp)) + ' ' + error.message));
    const lastMessage = errors.length > 0 ? errors[errors.length - 1].error.message : '';
    const prefill: IFormObj = {
      subject: `Application Error: ${lastMessage}`.slice(0, 250), // subject has max-length of 250
      text: `\n-- Include your description above --\nErrors encountered:\n${messages.join('\n')}\n`,
    };
    Beacon('prefill', prefill);
    Beacon('config', {messaging: {contactForm: {showSubject: false}}});

    errors.forEach(({error, timestamp}, i) => {
      attrs[`error-${i}`] =  timeFormat('D T', new Date(timestamp)) + ' ' + error.message;
      if (error.stack) {
        attrs[`error-${i}-stack`] = JSON.stringify(error.stack.trim().split('\n'));
      }
    });
    route = options.route || '/ask/message/';
  } else {
    Beacon('config', {messaging: {contactForm: {showSubject: true}}});
    route = options.route || '/answers/';
  }

  Beacon('session-data', {
    'Grist Version': `${version.version} (${version.gitcommit})`,
    ...attrs,
  });
  Beacon('open');
  Beacon('navigate', route);
}

export interface IBeaconOpenOptions {
  appModel: AppModel|null;
  includeAppErrors?: boolean;
  onOpen?: () => void;
  errors?: IAppError[];
  route?: BeaconRoute;
}

/**
 * Open the helpScout beacon to send us a message. Calls optional onOpen callback when the beacon
 * has opened. The topAppModel is used to get the current user.
 *
 * If includeAppErrors or errors is set, the beacon will open to submit an error report. With
 * includeAppErrors, it will include stack traces of errors in the notifier into the session-data.
 * If errors is set, it will include the specified errors.
 */
export function beaconOpenMessage(options: IBeaconOpenOptions) {
  const app = options.appModel;
  const errors = options.errors || [];
  if (options.includeAppErrors && app) {
    errors.push(...app.notifier.getFullAppErrors());
  }
  _beaconOpen(getBeaconUserObj(app), {...options, errors});
}


function getBeaconUserObj(appModel: AppModel|null): IUserObj|null {
  if (!appModel) { return null; }

  // ActiveSessionInfo["user"] includes optional helpScoutSignature too.
  const user = appModel.currentValidUser as ActiveSessionInfo["user"]|null;

  // For anon user, don't attempt to identify anything. Even the "company" field (when anon on a
  // team doc) isn't useful, because the user may be external to the company.
  if (!user) { return null; }

  // Use the company name only when it's not a personal org. Otherwise, it adds no information and
  // overrides more useful company name gleaned by HelpScout from the web.
  const org = appModel.currentOrg;
  const company = org && !org.owner ? appModel.currentOrgName : undefined;

  return pickBy({
    name: user.name,
    email: user.email,
    company,
    avatar: user.picture,
    signature: user.helpScoutSignature,
  }, identity);
}
