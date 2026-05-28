export type Direction = "long" | "short";
export type ZoneStatus = "watching" | "touched" | "signaled" | "invalidated";

export interface Candle {
  openTime: number;
  closeTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  closed: boolean;
}

export interface FvgZone {
  id: string;
  symbol: string;
  direction: Direction;
  low: number;
  high: number;
  createdAt: number;
  status: ZoneStatus;
  touchedAt?: number;
  reaction?: Reaction;
}

export interface Reaction {
  confirmed: boolean;
  type: "bullish_reclaim" | "bearish_reclaim" | "none";
  candleCloseTime: number;
  close: number;
}

export interface TradeTick {
  time: number;
  price: number;
  quoteQty: number;
  side: "buy" | "sell";
}

export interface DepthLevel {
  price: number;
  quantity: number;
}

export interface BookSnapshot {
  bids: DepthLevel[];
  asks: DepthLevel[];
  eventTime: number;
}

export interface FlowPhase {
  from: number;
  to: number;
  buyNotional: number;
  sellNotional: number;
  delta: number;
  openPrice?: number;
  closePrice?: number;
  priceChangeBps?: number;
  dominantAggression: "buyers" | "sellers" | "balanced";
}

export interface FlowSummary {
  absorption: FlowPhase;
  confirmation: FlowPhase;
  absorptionConfirmed: boolean;
  initiativeConfirmed: boolean;
  valid: boolean;
  rejectionReason?: string;
}

export interface TargetCandidate {
  price: number;
  takeProfit: number;
  rr: number;
  score: number;
  features: string[];
}

export interface DemoExecutionReceipt {
  mode: "disabled" | "vst";
  status: "not_sent" | "submitted" | "rejected";
  bingxSymbol?: string;
  quantity?: number;
  orderId?: string;
  message: string;
}

export interface Signal {
  id: string;
  timestamp: number;
  symbol: string;
  direction: Direction;
  zone: FvgZone;
  entry: number;
  stop: number;
  target: TargetCandidate;
  flow: FlowSummary;
  quality: "strong" | "valid";
  commentaryRu: string;
  execution?: DemoExecutionReceipt;
}
