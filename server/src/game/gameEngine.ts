import { type Card, makeDeck, shuffle } from "./cards.js";
import { compareHands, evaluateHand, type HandValue } from "./handEvaluator.js";

export type Street = "waiting" | "preflop" | "flop" | "turn" | "river" | "showdown" | "finished";
export type PlayerAction = "fold" | "check" | "call" | "bet" | "raise" | "all-in";
export type BettingMode = "no_limit" | "pot_limit" | "fixed_limit";
export type GameRules = {
  smallBlind: number;
  bigBlind: number;
  bettingMode: BettingMode;
  minRaise: number;
  maxBetPerRound?: number;
};

export type StartPlayer = {
  id: string;
  nickname: string;
  avatar: string;
  seat: number;
  chips: number;
  connected: boolean;
};

export type EnginePlayer = StartPlayer & {
  hand: Card[];
  bet: number;
  totalBet: number;
  folded: boolean;
  allIn: boolean;
  acted: boolean;
};

export type PotAward = {
  playerId: string;
  amount: number;
  handName: string;
  potIndex: number;
};

export type GameState = {
  handId: number;
  street: Street;
  deck: Card[];
  board: Card[];
  players: EnginePlayer[];
  dealerSeat: number;
  smallBlindSeat: number;
  bigBlindSeat: number;
  currentTurnSeat: number | null;
  currentBet: number;
  minRaise: number;
  smallBlind: number;
  bigBlind: number;
  showdown: boolean;
  winners: PotAward[];
};

export type PublicPlayer = Omit<EnginePlayer, "hand"> & {
  hand?: Card[];
  cardCount: number;
  isTurn: boolean;
};

export type PublicGameState = Omit<GameState, "deck" | "players"> & {
  pot: number;
  players: PublicPlayer[];
  availableActions: null | {
    toCall: number;
    minRaiseTo: number;
    maxRaiseTo: number;
    canCheck: boolean;
    canCall: boolean;
    canBet: boolean;
    canRaise: boolean;
    canAllIn: boolean;
  };
};

export class GameEngine {
  state: GameState;
  private readonly rules: GameRules;

  constructor(rules: Partial<GameRules> | { small: number; big: number } = {}) {
    this.rules = normalizeGameRules(rules);
    this.state = {
      handId: 0,
      street: "waiting",
      deck: [],
      board: [],
      players: [],
      dealerSeat: 0,
      smallBlindSeat: 0,
      bigBlindSeat: 0,
      currentTurnSeat: null,
      currentBet: 0,
      minRaise: this.rules.minRaise,
      smallBlind: this.rules.smallBlind,
      bigBlind: this.rules.bigBlind,
      showdown: false,
      winners: []
    };
  }

  startHand(players: StartPlayer[], options: { dealerSeat?: number; deck?: Card[]; random?: () => number } = {}): GameState {
    if (players.length < 2) throw new Error("At least two players are required");
    const sorted = [...players].sort((a, b) => a.seat - b.seat);
    for (const player of sorted) {
      if (!Number.isSafeInteger(player.chips) || player.chips < 0) throw new Error("Player chips must be a safe non-negative integer");
    }
    const dealerSeat = options.dealerSeat ?? sorted[0].seat;
    const smallBlindSeat = sorted.length === 2 ? dealerSeat : this.nextSeatFromList(sorted, dealerSeat);
    const bigBlindSeat = this.nextSeatFromList(sorted, smallBlindSeat);

    this.state = {
      handId: this.state.handId + 1,
      street: "preflop",
      deck: options.deck ? [...options.deck] : shuffle(makeDeck(), options.random),
      board: [],
      players: sorted.map((player) => ({
        ...player,
        hand: [],
        bet: 0,
        totalBet: 0,
        folded: false,
        allIn: false,
        acted: false
      })),
      dealerSeat,
      smallBlindSeat,
      bigBlindSeat,
      currentTurnSeat: null,
      currentBet: 0,
      minRaise: this.rules.minRaise,
      smallBlind: this.rules.smallBlind,
      bigBlind: this.rules.bigBlind,
      showdown: false,
      winners: []
    };

    this.contribute(smallBlindSeat, this.rules.smallBlind);
    this.contribute(bigBlindSeat, this.rules.bigBlind);
    this.state.currentBet = Math.max(...this.state.players.map((player) => player.bet));

    for (let round = 0; round < 2; round += 1) {
      for (const player of this.orderedFrom(dealerSeat)) {
        player.hand.push(this.draw());
      }
    }

    this.state.currentTurnSeat = this.nextSeat(bigBlindSeat, (player) => this.needsAction(player));
    if (this.awardIfOnlyOneLeft()) return this.state;
    if (this.livePlayers().every((player) => player.allIn)) {
      this.dealToRiver();
      this.finishShowdown();
    }
    return this.state;
  }

  executeAction(playerId: string, type: PlayerAction, amount = 0): GameState {
    if (!isPlayerAction(type)) throw new Error("Invalid action");
    const player = this.state.players.find((candidate) => candidate.id === playerId);
    if (!player) throw new Error("Player is not in this hand");
    if (player.seat !== this.state.currentTurnSeat) throw new Error("It is not this player's turn");
    if (player.folded) throw new Error("Folded players cannot act");
    if (player.allIn) throw new Error("All-in players cannot act");

    const toCall = Math.max(0, this.state.currentBet - player.bet);
    if (type === "fold") {
      player.folded = true;
      player.acted = true;
    } else if (type === "check") {
      if (toCall !== 0) throw new Error("Cannot check while facing a bet");
      player.acted = true;
    } else if (type === "call") {
      if (toCall <= 0) throw new Error("Nothing to call");
      this.contribute(player.seat, toCall);
      player.acted = true;
    } else if (type === "bet") {
      if (this.state.currentBet !== 0) throw new Error("Use raise while facing a bet");
      this.betTo(player, amount);
    } else if (type === "raise") {
      if (this.state.currentBet === 0) throw new Error("Use bet to open action");
      this.betTo(player, amount);
    } else if (type === "all-in") {
      this.betTo(player, player.bet + player.chips, true);
    } else {
      throw new Error("Invalid action");
    }

    this.afterAction(player.seat);
    return this.state;
  }

  autoAction(): GameState {
    const player = this.state.players.find((candidate) => candidate.seat === this.state.currentTurnSeat);
    if (!player) return this.state;
    const toCall = Math.max(0, this.state.currentBet - player.bet);
    return this.executeAction(player.id, toCall === 0 ? "check" : "fold");
  }

  updateConnection(playerId: string, connected: boolean): void {
    const player = this.state.players.find((candidate) => candidate.id === playerId);
    if (player) player.connected = connected;
  }

  getPublicState(viewerId: string): PublicGameState {
    const viewer = this.state.players.find((player) => player.id === viewerId);
    const availableActions = viewer && viewer.seat === this.state.currentTurnSeat ? this.availableActions(viewer) : null;
    return {
      ...this.state,
      pot: potTotal(this.state.players),
      players: this.state.players.map((player) => ({
        ...withoutHand(player),
        hand: player.id === viewerId || (this.state.showdown && !player.folded) ? player.hand : undefined,
        cardCount: player.hand.length,
        isTurn: player.seat === this.state.currentTurnSeat
      })),
      availableActions
    };
  }

  private betTo(player: EnginePlayer, targetBet: number, allIn = false): void {
    const maxBet = player.bet + player.chips;
    const nextBet = Math.min(readBetTarget(targetBet), maxBet);
    if (nextBet <= player.bet) throw new Error("Bet must add chips");
    if (!allIn && targetBet > maxBet) throw new Error("Not enough chips");

    const oldCurrentBet = this.state.currentBet;
    const maxLegal = this.maxLegalBetTo(player);
    if (nextBet > maxLegal) throw new Error(`Bet cannot exceed ${maxLegal}`);
    const raiseSize = oldCurrentBet === 0 ? nextBet : nextBet - oldCurrentBet;
    const isFullRaise = raiseSize >= this.state.minRaise;
    const isAllIn = nextBet === maxBet;
    const fixedTarget = oldCurrentBet === 0 ? this.state.minRaise : oldCurrentBet + this.state.minRaise;
    if (!allIn && this.rules.bettingMode === "fixed_limit" && nextBet !== fixedTarget) throw new Error(`Fixed-limit bet must be ${fixedTarget}`);
    if (nextBet <= oldCurrentBet && !isAllIn) throw new Error("Bet must beat the current bet");
    if (oldCurrentBet > 0 && !isAllIn && !isFullRaise) throw new Error("Raise is below the minimum");
    if (oldCurrentBet === 0 && !isAllIn && nextBet < this.state.minRaise) throw new Error("Opening bet is below the minimum");

    this.contribute(player.seat, nextBet - player.bet);
    if (player.bet > oldCurrentBet) {
      this.state.currentBet = player.bet;
      if (isFullRaise || oldCurrentBet === 0) this.state.minRaise = raiseSize;
      if (isFullRaise || oldCurrentBet === 0) {
        for (const other of this.state.players) {
          if (other.id !== player.id && this.canAct(other)) other.acted = false;
        }
      }
    }
    player.acted = true;
  }

  private afterAction(fromSeat = this.state.currentTurnSeat ?? this.state.dealerSeat): void {
    if (this.awardIfOnlyOneLeft()) return;
    if (this.livePlayers().every((player) => player.allIn)) {
      this.dealToRiver();
      this.finishShowdown();
      return;
    }
    if (this.bettingRoundComplete()) {
      this.advanceStreet();
      return;
    }
    this.state.currentTurnSeat = this.nextSeat(fromSeat, (player) => this.needsAction(player));
  }

  private advanceStreet(): void {
    for (const player of this.state.players) {
      player.bet = 0;
      player.acted = false;
    }
    this.state.currentBet = 0;
    this.state.minRaise = this.rules.minRaise;

    if (this.state.street === "preflop") {
      this.state.board.push(this.draw(), this.draw(), this.draw());
      this.state.street = "flop";
    } else if (this.state.street === "flop") {
      this.state.board.push(this.draw());
      this.state.street = "turn";
    } else if (this.state.street === "turn") {
      this.state.board.push(this.draw());
      this.state.street = "river";
    } else {
      this.finishShowdown();
      return;
    }

    if (this.livePlayers().every((player) => player.allIn)) {
      this.dealToRiver();
      this.finishShowdown();
      return;
    }

    const first = this.nextSeat(this.state.dealerSeat, (player) => this.needsAction(player));
    this.state.currentTurnSeat = first;
    if (first === null) this.advanceStreet();
  }

  private finishShowdown(): void {
    this.state.showdown = true;
    this.state.street = "finished";
    this.state.currentTurnSeat = null;
    const { awards } = settlePots(this.state.players, this.state.board, this.state.dealerSeat);
    this.state.winners = awards;
    for (const award of awards) {
      const player = this.state.players.find((candidate) => candidate.id === award.playerId);
      if (player) player.chips += award.amount;
    }
  }

  private awardIfOnlyOneLeft(): boolean {
    const live = this.livePlayers();
    if (live.length !== 1) return false;
    const winner = live[0];
    const amount = potTotal(this.state.players);
    winner.chips += amount;
    this.state.street = "finished";
    this.state.currentTurnSeat = null;
    this.state.winners = [{ playerId: winner.id, amount, handName: "Uncontested", potIndex: 0 }];
    return true;
  }

  private bettingRoundComplete(): boolean {
    return this.state.players
      .filter((player) => this.canAct(player))
      .every((player) => player.acted && player.bet === this.state.currentBet);
  }

  private needsAction(player: EnginePlayer): boolean {
    return this.canAct(player) && (!player.acted || player.bet < this.state.currentBet);
  }

  private canAct(player: EnginePlayer): boolean {
    return !player.folded && !player.allIn && player.chips > 0;
  }

  private livePlayers(): EnginePlayer[] {
    return this.state.players.filter((player) => !player.folded);
  }

  private contribute(seat: number, amount: number): number {
    if (!Number.isSafeInteger(amount) || amount < 0) throw new Error("Bet must be a safe positive integer");
    const player = this.playerAt(seat);
    const paid = Math.min(player.chips, amount);
    player.chips -= paid;
    player.bet += paid;
    player.totalBet += paid;
    if (player.chips === 0) player.allIn = true;
    return paid;
  }

  private draw(): Card {
    const card = this.state.deck.pop();
    if (!card) throw new Error("Deck is empty");
    return card;
  }

  private dealToRiver(): void {
    while (this.state.board.length < 5) this.state.board.push(this.draw());
  }

  private playerAt(seat: number): EnginePlayer {
    const player = this.state.players.find((candidate) => candidate.seat === seat);
    if (!player) throw new Error(`Seat ${seat} is empty`);
    return player;
  }

  private nextSeat(fromSeat: number, predicate: (player: EnginePlayer) => boolean): number | null {
    for (let offset = 1; offset <= 6; offset += 1) {
      const seat = (fromSeat + offset) % 6;
      const player = this.state.players.find((candidate) => candidate.seat === seat);
      if (player && predicate(player)) return seat;
    }
    return null;
  }

  private nextSeatFromList(players: StartPlayer[], fromSeat: number): number {
    for (let offset = 1; offset <= 6; offset += 1) {
      const seat = (fromSeat + offset) % 6;
      if (players.some((player) => player.seat === seat)) return seat;
    }
    throw new Error("No next occupied seat");
  }

  private orderedFrom(fromSeat: number): EnginePlayer[] {
    const ordered: EnginePlayer[] = [];
    for (let offset = 1; offset <= 6; offset += 1) {
      const seat = (fromSeat + offset) % 6;
      const player = this.state.players.find((candidate) => candidate.seat === seat);
      if (player) ordered.push(player);
    }
    return ordered;
  }

  private availableActions(player: EnginePlayer): PublicGameState["availableActions"] {
    const toCall = Math.max(0, this.state.currentBet - player.bet);
    const maxRaiseTo = this.maxLegalBetTo(player);
    const minOpen = Math.min(this.state.minRaise, maxRaiseTo);
    const minRaiseTo = Math.min(this.state.currentBet === 0 ? minOpen : this.state.currentBet + this.state.minRaise, maxRaiseTo);
    return {
      toCall,
      minRaiseTo,
      maxRaiseTo,
      canCheck: toCall === 0,
      canCall: toCall > 0,
      canBet: this.state.currentBet === 0 && player.chips > 0,
      canRaise: this.state.currentBet > 0 && maxRaiseTo > this.state.currentBet,
      canAllIn: player.chips > 0
    };
  }

  private maxLegalBetTo(player: EnginePlayer): number {
    const stackMax = player.bet + player.chips;
    const roundMax = this.rules.maxBetPerRound ? Math.min(stackMax, this.rules.maxBetPerRound) : stackMax;
    if (this.rules.bettingMode === "fixed_limit") {
      const fixedTarget = this.state.currentBet === 0 ? this.state.minRaise : this.state.currentBet + this.state.minRaise;
      return Math.min(roundMax, fixedTarget);
    }
    if (this.rules.bettingMode === "pot_limit") {
      const toCall = Math.max(0, this.state.currentBet - player.bet);
      const potAfterCall = potTotal(this.state.players) + toCall;
      const potTarget = this.state.currentBet === 0 ? potAfterCall : this.state.currentBet + potAfterCall;
      return Math.min(roundMax, potTarget);
    }
    return roundMax;
  }
}

export function potTotal(players: Pick<EnginePlayer, "totalBet">[]): number {
  return players.reduce((sum, player) => sum + player.totalBet, 0);
}

export function settlePots(players: EnginePlayer[], board: Card[], dealerSeat = 0): { awards: PotAward[] } {
  const levels = [...new Set(players.map((player) => player.totalBet).filter((bet) => bet > 0))].sort((a, b) => a - b);
  const totals = new Map<string, number>();
  const awards: PotAward[] = [];
  let previous = 0;

  levels.forEach((level, potIndex) => {
    const contributors = players.filter((player) => player.totalBet >= level);
    const eligible = contributors.filter((player) => !player.folded);
    const amount = (level - previous) * contributors.length;
    previous = level;
    if (amount <= 0 || eligible.length === 0) return;

    const values = eligible.map((player) => ({ player, value: evaluateHand([...player.hand, ...board]) }));
    const best = values.reduce((winner, current) => (compareHands(current.value, winner.value) > 0 ? current : winner));
    const winners = values.filter((entry) => compareHands(entry.value, best.value) === 0).map((entry) => entry.player);
    const share = Math.floor(amount / winners.length);
    let remainder = amount % winners.length;

    for (const winner of orderWinners(winners, dealerSeat)) {
      const paid = share + (remainder > 0 ? 1 : 0);
      remainder -= remainder > 0 ? 1 : 0;
      totals.set(winner.id, (totals.get(winner.id) ?? 0) + paid);
      awards.push({ playerId: winner.id, amount: paid, handName: best.value.name, potIndex });
    }
  });

  return {
    awards: [...totals.entries()].map(([playerId, amount]) => {
      const first = awards.find((award) => award.playerId === playerId);
      return { playerId, amount, handName: first?.handName ?? "High card", potIndex: first?.potIndex ?? 0 };
    })
  };
}

function withoutHand(player: EnginePlayer): Omit<EnginePlayer, "hand"> {
  const { hand: _hand, ...rest } = player;
  return rest;
}

function orderWinners(winners: EnginePlayer[], dealerSeat: number): EnginePlayer[] {
  return [...winners].sort((a, b) => ((a.seat - dealerSeat + 6) % 6) - ((b.seat - dealerSeat + 6) % 6));
}

function normalizeGameRules(input: Partial<GameRules> | { small: number; big: number }): GameRules {
  if ("small" in input || "big" in input) {
    const legacy = input as { small?: number; big?: number };
    return {
      smallBlind: positiveInt(legacy.small, 10),
      bigBlind: positiveInt(legacy.big, 20),
      bettingMode: "no_limit",
      minRaise: positiveInt(legacy.big, 20)
    };
  }
  const rules = input as Partial<GameRules>;
  const bigBlind = positiveInt(rules.bigBlind, 20);
  return {
    smallBlind: positiveInt(rules.smallBlind, 10),
    bigBlind,
    bettingMode: rules.bettingMode ?? "no_limit",
    minRaise: positiveInt(rules.minRaise, bigBlind),
    maxBetPerRound: rules.maxBetPerRound
  };
}

function positiveInt(value: unknown, fallback: number): number {
  const number = Math.floor(Number(value));
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function isPlayerAction(value: unknown): value is PlayerAction {
  return value === "fold" || value === "check" || value === "call" || value === "bet" || value === "raise" || value === "all-in";
}

function readBetTarget(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error("Bet must be a safe positive integer");
  return value;
}
