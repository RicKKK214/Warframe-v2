export type PricingMode = 'lowest' | 'median3' | 'median5' | 'weighted';
export type Strategy = 'PARTS_TO_SET' | 'SET_TO_PARTS';
export type Category =
  | 'warframe' | 'primary' | 'secondary' | 'melee' | 'sentinel'
  | 'archwing' | 'companion' | 'other';

export interface WfmUser {
  id: string;
  ingameName: string;
  status?: 'ingame' | 'online' | 'offline' | string;
  platform?: string;
  crossplay?: boolean;
  reputation?: number;
  lastSeen?: string;
}

export interface WfmOrder {
  id: string;
  type: 'buy' | 'sell';
  platinum: number;
  quantity: number;
  perTrade?: number;
  visible?: boolean;
  createdAt?: string;
  updatedAt?: string;
  itemId?: string;
  user?: WfmUser;
}

export interface WfmItemShort {
  id: string;
  slug: string;
  gameRef?: string;
  tags?: string[];
  ducats?: number;
  i18n?: Record<string, { name?: string; thumb?: string; icon?: string }>;
}

export interface WfmItemFull extends WfmItemShort {
  setRoot?: boolean;
  setParts?: string[];
  quantityInSet?: number;
  tradable?: boolean;
  reqMasteryRank?: number;
  tradingTax?: number;
}

export interface PriceStat {
  price: number | null;
  count: number;
  onlineCount: number;
  cheapest: number[];
  spread1to5: number | null;
}

export interface OrderBook {
  slug: string;
  fetchedAt: number;
  sell: WfmOrder[];
  buy: WfmOrder[];
}

export interface PartLine {
  slug: string;
  name: string;
  quantity: number;
  cheapestSell: number | null;
  recommendedSell: number | null;
  bestBuy: number | null;
  sellers: number;
  buyers: number;
}

export interface StrategyResult {
  strategy: Strategy;
  investment: number | null;
  instantRevenue: number | null;
  instantProfit: number | null;
  instantRoi: number | null;
  listingRevenue: number | null;
  listingProfit: number | null;
  listingRoi: number | null;
}

export interface SetAnalysis {
  slug: string;
  name: string;
  category: Category;
  thumb?: string | null;
  partCount: number;
  parts: PartLine[];
  set: {
    cheapestSell: number | null;
    recommendedSell: number | null;
    bestBuy: number | null;
    sellers: number;
    buyers: number;
  };
  partsCost: number | null;
  partsSaleValue: number | null;
  partsInstantValue: number | null;
  strategies: StrategyResult[];
  bestStrategy: StrategyResult | null;
  confidence: number;
  confidenceLabel: 'High' | 'Medium' | 'Low';
  updatedAt: number;
}
