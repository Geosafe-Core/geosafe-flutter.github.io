/*
 * GeoSafe WalletConnect interop glue for the Flutter web build.
 *
 * Bundles @reown/appkit (the SAME JS AppKit the React app uses) and exposes a
 * tiny imperative API on window.GeoSafeWC that the Flutter/Dart web target
 * drives via dart:js_interop. This gives the Flutter web build the exact modal
 * + connect/QR/extension behaviour of geosafe-web — the Dart reown_appkit SDK
 * is only used on the mobile builds.
 *
 * Mirrors geosafe-web's walletConnect.ts (createAppKit, ensureInit,
 * ensureConnected, verifyWalletPermission, sendTransaction).
 *
 * Build (self-contained — deps pinned in this dir's package.json):
 *   cd web/interop && npm ci && npm run build   # → ../wc_interop.js
 * The output bundle is generated (gitignored); only this source is committed.
 * CI and ./scripts/build_web.sh run the same step before `flutter build web`.
 */
import { createAppKit } from '@reown/appkit';
import { EthersAdapter } from '@reown/appkit-adapter-ethers';
import { defineChain } from '@reown/appkit/networks';

let appKit = null;
let initPromise = null;
let sessionReady = Promise.resolve();
let cfg = null;          // { projectId, networks:[{chainId,name,rpcUrl,blockExplorerUrl}], defaultChainId }
let stateListener = null; // Dart callback(jsonString)

function toChain(n) {
  return defineChain({
    id: n.chainId,
    caipNetworkId: `eip155:${n.chainId}`,
    chainNamespace: 'eip155',
    name: n.name,
    nativeCurrency: { decimals: 18, name: 'Ether', symbol: 'ETH' },
    rpcUrls: { default: { http: [n.rpcUrl] } },
    ...(n.blockExplorerUrl
      ? { blockExplorers: { default: { name: 'Explorer', url: n.blockExplorerUrl } } }
      : {}),
  });
}

function connected() {
  return !!(appKit && appKit.getWalletProvider());
}

function currentAddress() {
  if (!connected()) return null;
  try { return appKit.getAddress?.() ?? null; } catch (_) { return null; }
}

function currentChainId() {
  try {
    const r = appKit?.getChainId();
    return r !== undefined && r !== null ? Number(r) : null;
  } catch (_) { return null; }
}

// Pull the human-useful string out of a wallet/ethers/provider error object.
function errMsg(e) {
  if (e == null) return 'Unknown error';
  if (typeof e === 'string') return e;
  return (
    e.reason ||
    e.shortMessage ||
    (e.data && e.data.message) ||
    (e.error && e.error.message) ||
    e.message ||
    (() => { try { return JSON.stringify(e); } catch (_) { return String(e); } })()
  );
}

function emitState() {
  if (!stateListener) return;
  try {
    stateListener(JSON.stringify({
      connected: connected(),
      address: currentAddress(),
      chainId: currentChainId(),
    }));
  } catch (_) { /* ignore listener errors */ }
}

async function ensureInit() {
  if (appKit) return;
  if (initPromise) return initPromise;
  initPromise = (async () => {
    if (!cfg || !cfg.projectId) {
      throw new Error('WalletConnect is not configured.');
    }
    const adapter = new EthersAdapter();
    const networks = cfg.networks.map(toChain);
    const def = networks.find((c) => Number(c.id) === cfg.defaultChainId) || networks[0];
    appKit = createAppKit({
      adapters: [adapter],
      networks,
      defaultNetwork: def,
      projectId: cfg.projectId,
      metadata: {
        name: 'GeoSafe',
        description: 'Location-secured crypto wallet',
        url: window.location.origin,
        icons: [],
      },
    });

    let resolveReady;
    sessionReady = new Promise((r) => { resolveReady = r; });
    const t = setTimeout(resolveReady, 3000);
    appKit.subscribeAccount((s) => {
      if (s && s.status === 'reconnecting') return;
      clearTimeout(t);
      resolveReady();
      emitState();
    });
  })();
  initPromise.catch(() => { initPromise = null; });
  return initPromise;
}

// Make sure the wallet is on `chainId`. For an injected wallet (MetaMask
// extension) wallet_switchEthereumChain works; if the chain isn't known we add
// it with OUR rpcUrl so the wallet doesn't fall back to a flaky built-in node
// (the cause of "RPC endpoint returned too many errors" during broadcast).
async function ensureChain(wp, chainId) {
  let current = null;
  try { current = parseInt(await wp.request({ method: 'eth_chainId', params: [] }), 16); } catch (_) {}
  if (current === chainId) return;
  const hex = '0x' + chainId.toString(16);
  try {
    await wp.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: hex }] });
  } catch (e) {
    const code = e && e.code;
    const unknown = code === 4902 || /unrecognized chain|not added|add this network/i.test((e && e.message) || '');
    if (!unknown) throw e;
    const net = (cfg.networks || []).find((n) => Number(n.chainId) === chainId);
    if (!net) throw e;
    await wp.request({
      method: 'wallet_addEthereumChain',
      params: [{
        chainId: hex,
        chainName: net.name,
        rpcUrls: [net.rpcUrl],
        nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
        blockExplorerUrls: net.blockExplorerUrl ? [net.blockExplorerUrl] : [],
      }],
    });
  }
}

async function walletChainId(wp) {
  try { return parseInt(await wp.request({ method: 'eth_chainId', params: [] }), 16); } catch (_) { return null; }
}

async function ensureConnected() {
  const kit = appKit;
  await sessionReady;
  if (kit.getWalletProvider()) return;
  return new Promise((resolve, reject) => {
    const unsub = kit.subscribeEvents((ev) => {
      const event = ev && ev.data && ev.data.event;
      if (event === 'CONNECT_SUCCESS') {
        unsub(); resolve();
      } else if (event === 'MODAL_CLOSE' || event === 'CONNECT_ERROR') {
        if (kit.getWalletProvider()) { unsub(); resolve(); }
        else if (event === 'MODAL_CLOSE') {
          unsub();
          const e = new Error('Connect your wallet to continue.');
          e.code = 'USER_REJECTED';
          reject(e);
        } else {
          unsub();
          reject(new Error('Failed to connect wallet. Please try again.'));
        }
      }
    });
    kit.open().catch((e) => { unsub(); reject(e instanceof Error ? e : new Error('Failed to open wallet modal.')); });
  });
}

const api = {
  // Sync config — call before connect()/sendTransaction().
  configure(projectId, networksJson, defaultChainId) {
    cfg = {
      projectId,
      networks: JSON.parse(networksJson),
      defaultChainId: Number(defaultChainId),
    };
  },

  setStateListener(cb) { stateListener = cb; },

  // Always resolves with a JSON envelope string — never rejects — so the Dart
  // side gets a readable message instead of an opaque boxed JS error object.
  //   success: {"ok":true, "address":..., "chainId":...}
  //   failure: {"ok":false, "error":"<message>", "code":"<code>"}
  async connect() {
    try {
      await ensureInit();
      await ensureConnected();
      let address = null;
      const wp = appKit.getWalletProvider();
      if (wp) {
        // Force the wallet's ACCOUNT PICKER. MetaMask stores a per-site account
        // permission: once a site is authorized with account A, plain
        // eth_requestAccounts silently returns A forever — even if the user has
        // a different account selected — which is why a stale Hardhat account
        // kept coming back. wallet_requestPermissions({eth_accounts:{}})
        // re-prompts account selection so the user can choose. Not all wallets
        // (e.g. some WC mobile) support it; fall through to eth_requestAccounts.
        try {
          await wp.request({
            method: 'wallet_requestPermissions',
            params: [{ eth_accounts: {} }],
          });
        } catch (e) {
          const code = e && e.code;
          if (code === 4001 || code === 'ACTION_REJECTED') {
            const err = new Error('Connect your wallet to continue.');
            err.code = 'USER_REJECTED';
            throw err;
          }
          /* unsupported method → fall through */
        }
        // Read the chosen account straight from the wallet, so we don't depend
        // on AppKit's cached address lagging the accountsChanged event.
        try {
          const accts = await wp.request({ method: 'eth_requestAccounts', params: [] });
          if (Array.isArray(accts) && accts.length) address = accts[0];
        } catch (_) { /* fall back to AppKit's address below */ }
      }
      if (!address) address = currentAddress();
      if (!address) throw new Error('Wallet connected but no address returned.');
      // Explicitly dismiss the AppKit modal. It does NOT reliably self-close
      // here: the post-connect wallet_requestPermissions / eth_requestAccounts
      // dance above leaves the modal stuck on its "connecting" spinner, so the
      // user is left staring at a loading popup after authorizing. Closing it
      // ourselves is the only dependable dismissal.
      try { await appKit.close(); } catch (_) { /* already closed — ignore */ }
      emitState();
      return JSON.stringify({ ok: true, address, chainId: currentChainId() });
    } catch (e) {
      return JSON.stringify({ ok: false, error: errMsg(e), code: String((e && e.code) || '') });
    }
  },

  // Envelope: {"ok":true,"hash":...} or {"ok":false,"error":...,"code":...}.
  // `gas` (hex) is optional; when present it's included so the wallet doesn't
  // have to estimate gas itself (its built-in RPC can be flaky and fail with
  // "RPC endpoint returned too many errors" before showing a confirmation).
  async sendTransaction(to, data, value, gas) {
    let stage = 'init';
    const L = (...a) => { try { console.log('[GSWC:send]', ...a); } catch (_) {} };
    L('start', { to, value, gas, providerType: appKit && appKit.getWalletProviderType && appKit.getWalletProviderType() });
    try {
      stage = 'ensureInit'; await ensureInit();
      stage = 'ensureConnected'; await ensureConnected();
      const wp = appKit.getWalletProvider();
      L('provider', { hasProvider: !!wp, type: appKit.getWalletProviderType && appKit.getWalletProviderType() });
      if (!wp) throw new Error('Wallet provider unavailable.');
      // PASSIVE account read only — eth_requestAccounts was already done at
      // connect time. Calling it here overlaps the send → MetaMask -32002.
      stage = 'eth_accounts';
      let from = currentAddress();
      if (!from) {
        const accounts = await wp.request({ method: 'eth_accounts', params: [] });
        from = accounts && accounts[0];
      }
      L('accounts', { from });
      if (!from) throw new Error('Wallet returned no account.');
      stage = 'eth_chainId(pre)';
      const preChain = await walletChainId(wp);
      L('walletChain', { preChain, target: cfg.defaultChainId });
      stage = 'ensureChain';
      await ensureChain(wp, cfg.defaultChainId);
      const postChain = await walletChainId(wp);
      L('walletChain(post)', { postChain });
      // '0x' is not a valid quantity for `value` — wallets reject it
      // ("invalid transaction value"). Normalize empty/'0x' to '0x0'.
      const txValue = (!value || value === '0x') ? '0x0' : value;
      const tx = { from, to, data, value: txValue };
      if (gas) tx.gas = gas;
      stage = 'eth_sendTransaction';
      L('sending tx', tx);
      const hash = await wp.request({ method: 'eth_sendTransaction', params: [tx] });
      L('hash', hash);
      emitState();
      return JSON.stringify({ ok: true, hash });
    } catch (e) {
      console.error('[GSWC:send] FAILED at stage=' + stage, e);
      const wp2 = appKit && appKit.getWalletProvider();
      const chain = wp2 ? await walletChainId(wp2) : null;
      let providerType = '';
      try { providerType = appKit.getWalletProviderType && appKit.getWalletProviderType() || ''; } catch (_) {}
      let raw = '';
      try {
        raw = JSON.stringify({
          name: e && e.name, code: e && e.code, message: e && e.message,
          reason: e && e.reason, shortMessage: e && e.shortMessage,
          data: e && e.data,
          cause: e && e.cause ? { code: e.cause.code, message: e.cause.message } : undefined,
          keys: e ? Object.keys(e) : [],
        });
      } catch (_) { raw = String(e); }
      return JSON.stringify({
        ok: false,
        stage,
        error: errMsg(e),
        code: String((e && e.code) || ''),
        providerType,
        walletChainId: chain,
        targetChainId: cfg && cfg.defaultChainId,
        raw,
      });
    }
  },

  async disconnect() {
    if (appKit) { try { await appKit.disconnect(); } catch (_) { /* ignore */ } }
    emitState();
  },

  getAddress() { return currentAddress(); },
  getChainId() { return currentChainId(); },
};

window.GeoSafeWC = api;
