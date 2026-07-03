import type { OptionRight } from '../domain/instrument.js';

export interface Black76Input {
  right: OptionRight;
  forward: number;
  strike: number;
  timeToExpiryYears: number;
  volatility: number;
  riskFreeRate?: number;
}

export interface Black76Greeks {
  price: number;
  delta: number;
  gamma: number;
  theta: number;
  vega: number;
}

const SQRT_2PI = Math.sqrt(2 * Math.PI);

export function normalPdf(x: number): number {
  return Math.exp(-0.5 * x * x) / SQRT_2PI;
}

export function normalCdf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const z = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * z);
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const erf = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-z * z);
  return 0.5 * (1 + sign * erf);
}

function discount(r: number, t: number): number {
  return Math.exp(-r * t);
}

function intrinsic(right: OptionRight, forward: number, strike: number, r: number, t: number): number {
  const raw = right === 'CE' ? Math.max(0, forward - strike) : Math.max(0, strike - forward);
  return discount(r, t) * raw;
}

export function black76Price(input: Black76Input): number {
  const r = input.riskFreeRate ?? 0;
  const t = input.timeToExpiryYears;
  const f = input.forward;
  const k = input.strike;
  const sigma = input.volatility;

  if (t <= 0 || sigma <= 0 || f <= 0 || k <= 0) return intrinsic(input.right, f, k, r, Math.max(0, t));

  const sqrtT = Math.sqrt(t);
  const d1 = (Math.log(f / k) + 0.5 * sigma * sigma * t) / (sigma * sqrtT);
  const d2 = d1 - sigma * sqrtT;
  const df = discount(r, t);

  if (input.right === 'CE') return df * (f * normalCdf(d1) - k * normalCdf(d2));
  return df * (k * normalCdf(-d2) - f * normalCdf(-d1));
}

export function black76Greeks(input: Black76Input): Black76Greeks {
  const r = input.riskFreeRate ?? 0;
  const t = input.timeToExpiryYears;
  const f = input.forward;
  const k = input.strike;
  const sigma = input.volatility;
  const price = black76Price(input);

  if (t <= 0 || sigma <= 0 || f <= 0 || k <= 0) {
    return { price, delta: 0, gamma: 0, theta: 0, vega: 0 };
  }

  const sqrtT = Math.sqrt(t);
  const d1 = (Math.log(f / k) + 0.5 * sigma * sigma * t) / (sigma * sqrtT);
  const d2 = d1 - sigma * sqrtT;
  const df = discount(r, t);
  const cpDelta = input.right === 'CE' ? normalCdf(d1) : normalCdf(d1) - 1;
  const thetaCarry = input.right === 'CE'
    ? r * df * (f * normalCdf(d1) - k * normalCdf(d2))
    : r * df * (k * normalCdf(-d2) - f * normalCdf(-d1));

  return {
    price,
    delta: df * cpDelta,
    gamma: df * normalPdf(d1) / (f * sigma * sqrtT),
    theta: -(df * f * normalPdf(d1) * sigma) / (2 * sqrtT) + thetaCarry,
    vega: df * f * normalPdf(d1) * sqrtT,
  };
}

export interface ImpliedVolOptions {
  riskFreeRate?: number;
  minVol?: number;
  maxVol?: number;
  tolerance?: number;
  maxIterations?: number;
}

export function impliedVolBlack76(
  right: OptionRight,
  marketPrice: number,
  forward: number,
  strike: number,
  timeToExpiryYears: number,
  opts: ImpliedVolOptions = {},
): number {
  const r = opts.riskFreeRate ?? 0;
  const minVol = opts.minVol ?? 1e-6;
  const maxVol = opts.maxVol ?? 5;
  const tolerance = opts.tolerance ?? 1e-8;
  const maxIterations = opts.maxIterations ?? 100;

  if (marketPrice < intrinsic(right, forward, strike, r, Math.max(0, timeToExpiryYears)) - tolerance) {
    throw new Error('market price is below discounted intrinsic value');
  }

  let lo = minVol;
  let hi = maxVol;
  for (let i = 0; i < maxIterations; i++) {
    const mid = (lo + hi) / 2;
    const px = black76Price({
      right,
      forward,
      strike,
      timeToExpiryYears,
      volatility: mid,
      riskFreeRate: r,
    });
    if (Math.abs(px - marketPrice) <= tolerance) return mid;
    if (px > marketPrice) hi = mid;
    else lo = mid;
  }
  return (lo + hi) / 2;
}
