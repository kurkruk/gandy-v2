import React, { useState, useEffect, useRef, useCallback, memo } from "react";
import { createRoot } from "react-dom/client";

// --- TYPES & CONSTANTS ---

type Suit = "spades" | "hearts" | "clubs" | "diamonds" | "joker";
type Rank = 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15 | 16 | 17;
// 11=J, 12=Q, 13=K, 14=A, 15=2, 16=Small Joker, 17=Big Joker

interface Card {
  id: string;
  suit: Suit;
  rank: Rank;
  display: string;
}

interface Player {
  id: number;
  name: string;
  isAi: boolean;
  hand: Card[];
  cardsLeft: number;
  hasPlayed: boolean;
  lastAction: "PLAY" | "PASS" | null;
  role: "host" | "guest" | "bot";
  color: string;
}

type HandType = "SINGLE" | "PAIR" | "STRAIGHT" | "BOMB" | "KING_BOMB" | "INVALID";

interface PlayedHand {
  playerId: number;
  cards: Card[];
  type: HandType;
  primaryRank: number;
  length: number;
  bombLevel: number;
}

interface GameState {
  status: "lobby" | "dealing" | "playing" | "celebrating" | "scoring";
  players: Player[];
  deck: Card[];
  tablePile: PlayedHand[];
  currentPlayerIndex: number;
  lastWinnerIndex: number;
  passesInARow: number;
  bombCount: number;
  scores: { [playerId: number]: number };
}

const SUITS: Suit[] = ["spades", "hearts", "clubs", "diamonds"];
const RANKS = [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]; // 3-2
const BOT_COLORS = ["#ef5350", "#ab47bc", "#5c6bc0", "#26c6da", "#66bb6a", "#ffa726", "#8d6e63"];

// --- AUDIO SYSTEM ---

class SoundManager {
  ctx: AudioContext | null = null;
  muted: boolean = false;

  init() {
    if (!this.ctx) {
      this.ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
    }
    if (this.ctx.state === 'suspended') {
      this.ctx.resume();
    }
  }

  playTone(freq: number, type: OscillatorType, duration: number, vol: number = 0.1) {
    if (this.muted || !this.ctx) return;
    try {
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(freq, this.ctx.currentTime);
      gain.gain.setValueAtTime(vol, this.ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.01, this.ctx.currentTime + duration);
      osc.connect(gain);
      gain.connect(this.ctx.destination);
      osc.start();
      osc.stop(this.ctx.currentTime + duration);
    } catch (e) {
      console.error(e);
    }
  }

  playClick() { this.playTone(800, 'sine', 0.05, 0.05); }
  playDeal() { this.playTone(600, 'triangle', 0.05, 0.05); }
  playCard() { this.playTone(400, 'sine', 0.1, 0.1); }
  playPass() { this.playTone(200, 'sawtooth', 0.15, 0.05); }
  playBomb() { 
    if (this.muted || !this.ctx) return;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(100, this.ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(10, this.ctx.currentTime + 0.5);
    gain.gain.setValueAtTime(0.3, this.ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, this.ctx.currentTime + 0.5);
    osc.connect(gain);
    gain.connect(this.ctx.destination);
    osc.start();
    osc.stop(this.ctx.currentTime + 0.5);
  }
  playWin() {
    if (this.muted || !this.ctx) return;
    [400, 500, 600, 800].forEach((f, i) => {
      setTimeout(() => this.playTone(f, 'square', 0.2, 0.1), i * 100);
    });
  }
}

// Instantiate globally to avoid re-creation
const audio = new SoundManager();

// --- UTILS ---

const generateDeck = (): Card[] => {
  const deck: Card[] = [];
  let id = 0;
  
  SUITS.forEach(suit => {
    RANKS.forEach(rank => {
      let display = String(rank);
      if (rank === 11) display = "J";
      if (rank === 12) display = "Q";
      if (rank === 13) display = "K";
      if (rank === 14) display = "A";
      if (rank === 15) display = "2";
      deck.push({ id: `c-${id++}`, suit, rank: rank as Rank, display });
    });
  });

  deck.push({ id: `c-${id++}`, suit: "joker", rank: 16, display: "小王" }); // Small
  deck.push({ id: `c-${id++}`, suit: "joker", rank: 17, display: "大王" }); // Big

  return deck;
};

const shuffle = (deck: Card[]) => {
  return [...deck].sort(() => Math.random() - 0.5);
};

const sortCards = (cards: Card[]) => {
  return [...cards].sort((a, b) => a.rank - b.rank);
};

// Core Rule Logic
const analyzeHand = (cards: Card[]): { type: HandType; primaryRank: number; length: number; bombLevel: number } | null => {
  if (cards.length === 0) return null;
  
  const sorted = sortCards(cards);
  const len = sorted.length;
  const jokers = sorted.filter(c => c.suit === "joker");
  const normals = sorted.filter(c => c.suit !== "joker");
  const jokerCount = jokers.length;

  // King Bomb
  if (len === 2 && jokerCount === 2) {
    return { type: "KING_BOMB", primaryRank: 17, length: 2, bombLevel: 99 };
  }

  if (normals.length === 0) return null;

  const uniqueRanks = Array.from(new Set(normals.map(c => c.rank)));

  // Single
  if (len === 1) {
    if (jokerCount > 0) return null;
    return { type: "SINGLE", primaryRank: sorted[0].rank, length: 1, bombLevel: 0 };
  }

  // Pair
  if (len === 2) {
    if (uniqueRanks.length === 1) {
      return { type: "PAIR", primaryRank: normals[0].rank, length: 2, bombLevel: 0 };
    }
    // Joker used as pair? e.g. 3 + Joker
    if (jokerCount === 1 && normals.length === 1) {
        return { type: "PAIR", primaryRank: normals[0].rank, length: 2, bombLevel: 0 };
    }
    return null;
  }

  // Bomb (3+ same rank)
  if (len >= 3 && uniqueRanks.length === 1) {
    const rank = normals[0].rank;
    const bombLevel = len - 2;
    return { type: "BOMB", primaryRank: rank, length: len, bombLevel };
  }

  // Bomb with Joker (e.g. 3,3,3,Joker)
  if (len >= 3 && uniqueRanks.length === 1 && jokerCount > 0) {
      const rank = normals[0].rank;
      const bombLevel = len - 2;
      return { type: "BOMB", primaryRank: rank, length: len, bombLevel };
  }

  // Straight
  if (len >= 3 && uniqueRanks.length > 1) {
    // Basic Straight Logic + Joker handling (simplified)
    // We check if the normal cards fit into a sequence pattern
    
    // Valid patterns: Standard (3,4,5), Virtual (14,15,3 => A,2,3), (15,3,4 => 2,3,4)
    // The Rank values are 3..15(2). 
    // Virtual 1: A(14), 2(15), 3(3)
    // Virtual 2: 2(15), 3(3), 4(4)
    // ...
    // Normal: k, k+1, k+2 ...
    
    // For simplicity with Jokers, we check gaps. 
    // If gaps <= jokerCount, it's a straight.
    // EXCEPT 2 cannot be in middle of standard straight.
    
    // Let's implement Strict Standard Straights for AI simplicity first.
    // If strict match fails, we assume invalid for now to prevent bugs.
    
    const validSeqs: number[][] = [];
    if (len >= 3) validSeqs.push([14, 15, ...Array.from({length: len-2}, (_, i) => 3+i)]); // A-2-3...
    if (len >= 3) validSeqs.push([15, ...Array.from({length: len-1}, (_, i) => 3+i)]); // 2-3-4...
    
    // Standard straights (3 to A)
    for (let start = 3; start <= 14 - len + 1; start++) {
      validSeqs.push(Array.from({length: len}, (_, i) => start + i));
    }

    for (const seq of validSeqs) {
       const seqSet = new Set(seq);
       const isSubset = normals.every(c => seqSet.has(c.rank));
       if (!isSubset) continue; // Cards don't fit in this sequence pattern
       
       // Check duplicates in normals (cannot have pair in straight)
       if (uniqueRanks.length !== normals.length) continue;

       // If we are here, normals fit in the sequence. 
       // We just need to ensure we have enough jokers to fill the missing spots.
       // But wait, user must provide the cards. 
       // Logic: input cards = normals + jokers. 
       // Sequence len = input cards len.
       // If normals are subset of sequence, and no duplicates, it automatically fits because len is same.
       
       let virtualId = -1;
       // Assign ID based on first card of sequence
       if (seq[0] === 14 && seq[1] === 15) virtualId = 1;
       else if (seq[0] === 15 && seq[1] === 3) virtualId = 2;
       else virtualId = seq[0];
       
       return { type: "STRAIGHT", primaryRank: virtualId, length: len, bombLevel: 0 };
    }
  }

  return null;
};

const canBeat = (move: NonNullable<ReturnType<typeof analyzeHand>>, last: PlayedHand): boolean => {
  if (move.type === "KING_BOMB") return true;
  if (last.type === "KING_BOMB") return false;

  if (move.type === "BOMB") {
    if (last.type !== "BOMB") return true;
    if (move.bombLevel > last.bombLevel) return true;
    if (move.bombLevel < last.bombLevel) return false;
    return move.primaryRank > last.primaryRank;
  }

  if (last.type === "BOMB") return false;

  if (move.type !== last.type) return false;
  if (move.length !== last.length) return false;

  // Gan Deng Yan Core Rule: Must be exactly Rank + 1 (or 2 covering)
  if (move.type === "SINGLE" || move.type === "PAIR") {
    const isTwo = move.primaryRank === 15;
    const target = last.primaryRank + 1;
    
    // Strict +1
    if (move.primaryRank === target) return true;
    
    // 2 beats anything (except 2 itself or bombs)
    // Note: 2 vs 2 handled by strict +1 (15 vs 15 is false)
    if (isTwo && last.primaryRank < 15) return true;
    
    return false;
  }

  if (move.type === "STRAIGHT") {
    return move.primaryRank === last.primaryRank + 1;
  }

  return false;
};

// AI STRATEGY (Pure Functions)

const calculateAiMove = (hand: Card[], lastHand: PlayedHand | null): { cards: Card[], analysis: any } | null => {
    // Helper finders
    const normals = hand.filter(c => c.suit !== "joker");
    const jokers = hand.filter(c => c.suit === "joker");

    const findSingle = (targetRank: number | null): Card[] | null => {
        for (const c of normals) {
            if (targetRank !== null) {
                if (c.rank === targetRank + 1) return [c];
                if (c.rank === 15 && targetRank < 15) return [c];
            } else {
                if (c.rank < 15) return [c]; // Prefer playing small singles
            }
        }
        // If free turn and only 2s or jokers left
        if (targetRank === null) {
             if (normals.length > 0) return [normals[0]];
             if (jokers.length > 0) return [jokers[0]];
        }
        return null;
    };

    const findPair = (targetRank: number | null): Card[] | null => {
        const groups: {[k:number]: Card[]} = {};
        normals.forEach(c => { if(!groups[c.rank]) groups[c.rank]=[]; groups[c.rank].push(c); });
        
        for (const rStr in groups) {
            const r = Number(rStr);
            if (groups[r].length >= 2) {
                if (targetRank !== null) {
                    if (r === targetRank + 1) return groups[r].slice(0, 2);
                    if (r === 15 && targetRank < 15) return groups[r].slice(0, 2);
                } else {
                    return groups[r].slice(0, 2);
                }
            }
        }
        return null;
    };

    const findStraight = (minLen: number, targetRank: number | null): Card[] | null => {
        // Simplified: only looks for standard straights in normals
        const groups: {[k:number]: Card} = {};
        normals.forEach(c => groups[c.rank] = c);
        const ranks = Object.keys(groups).map(Number).sort((a,b)=>a-b);
        
        for (let i = 0; i <= ranks.length - minLen; i++) {
            let seq: Card[] = [];
            let current = ranks[i];
            let valid = true;
            for (let j = 0; j < minLen; j++) {
                if (ranks[i+j] !== current + j) { valid = false; break; }
                seq.push(groups[ranks[i+j]]);
            }
            if (valid) {
                if (targetRank !== null) {
                    if (current === targetRank + 1) return seq;
                } else {
                    return seq;
                }
            }
        }
        return null;
    };

    const findBomb = (levelToBeat: number, rankToBeat: number): Card[] | null => {
        const groups: {[k:number]: Card[]} = {};
        hand.forEach(c => { if(c.suit !== 'joker') { if(!groups[c.rank]) groups[c.rank]=[]; groups[c.rank].push(c); }});
        
        for (const rStr in groups) {
            const r = Number(rStr);
            const count = groups[r].length;
            if (count >= 3) {
                const myLevel = count - 2;
                if (myLevel > levelToBeat || (myLevel === levelToBeat && r > rankToBeat)) {
                    return groups[r];
                }
            }
        }
        if (jokers.length === 2) return jokers;
        return null;
    };

    let move: Card[] | null = null;
    let analysis: any = null;

    if (!lastHand) {
        // FREE TURN
        const s = findStraight(3, null);
        if (s) { move = s; }
        else {
            const p = findPair(null);
            if (p) { move = p; }
            else {
                const sg = findSingle(null);
                if (sg) { move = sg; }
            }
        }
        if (!move && hand.length > 0) move = [hand[0]];
    } else {
        // RESPOND TURN
        if (lastHand.type === "SINGLE") move = findSingle(lastHand.primaryRank);
        else if (lastHand.type === "PAIR") move = findPair(lastHand.primaryRank);
        else if (lastHand.type === "STRAIGHT") move = findStraight(lastHand.length, lastHand.primaryRank);

        // Try Bomb if regular move fails
        if (!move && lastHand.type !== "KING_BOMB") {
            const lvl = lastHand.type === "BOMB" ? lastHand.bombLevel : 0;
            const rk = lastHand.type === "BOMB" ? lastHand.primaryRank : 0;
            move = findBomb(lvl, rk);
        }
    }

    if (move) {
        analysis = analyzeHand(move);
        return { cards: move, analysis };
    }
    return null;
};

// --- COMPONENTS ---

// Memoized Card Component for Performance
const CardView: React.FC<{ card: Card; selected?: boolean; small?: boolean; onClick?: () => void }> = memo(({ card, selected, small, onClick }) => {
  const isRed = card.suit === "hearts" || card.suit === "diamonds" || (card.suit === "joker" && card.rank === 17);
  const isJoker = card.suit === "joker";
  
  let suitIcon = "";
  if (!isJoker) {
    if (card.suit === "spades") suitIcon = "♠";
    else if (card.suit === "hearts") suitIcon = "♥";
    else if (card.suit === "clubs") suitIcon = "♣";
    else if (card.suit === "diamonds") suitIcon = "♦";
  }

  const isTen = card.rank === 10;
  
  const jokerTextStyle: React.CSSProperties = {
     writingMode: "vertical-rl",
     textOrientation: "upright",
     fontSize: small ? "10px" : "14px",
     fontWeight: "bold",
     marginLeft: "0px",
     marginTop: "2px"
  };

  return (
    <div 
      className={`card ${isRed ? "red" : "black"} ${selected ? "selected" : ""} ${small ? "card-sm" : "card-lg"} animate-pop`}
      onClick={onClick}
      style={{ display: "block" }} 
    >
      {isJoker ? (
        <>
           <div style={{ position: "absolute", top: "2px", left: "2px", display: "flex", flexDirection: "column", alignItems: "center", lineHeight: "1.1" }}>
              <div style={jokerTextStyle}>{card.display}</div>
           </div>
           <div className="card-center" style={{ fontSize: small ? "1.5rem" : "2.5rem", opacity: 1 }}>🤡</div>
           <div style={{ position: "absolute", bottom: "2px", right: "2px", transform: "rotate(180deg)", display: "flex", flexDirection: "column", alignItems: "center", lineHeight: "1.1" }}>
              <div style={jokerTextStyle}>{card.display}</div>
           </div>
        </>
      ) : (
        <>
           <div style={{ position: "absolute", top: "4px", left: "4px", display: "flex", flexDirection: "column", alignItems: "center", lineHeight: "1" }}>
              <div className="card-value" style={isTen ? { letterSpacing: "-2px", marginLeft: "-2px" } : {}}>
                  {card.display}
              </div>
              <div className="card-suit">{suitIcon}</div>
           </div>
           <div className="card-center" style={{ fontSize: small ? "1.5rem" : "2rem" }}>{suitIcon}</div>
           <div style={{ position: "absolute", bottom: "4px", right: "4px", transform: "rotate(180deg)", display: "flex", flexDirection: "column", alignItems: "center", lineHeight: "1" }}>
              <div className="card-value" style={isTen ? { letterSpacing: "-2px", marginLeft: "-2px" } : {}}>
                  {card.display}
              </div>
              <div className="card-suit">{suitIcon}</div>
           </div>
        </>
      )}
    </div>
  );
});

const Confetti = memo(() => {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;

    const particles: any[] = [];
    const colors = ["#f44336", "#2196f3", "#ffeb3b", "#4caf50", "#9c27b0"];

    for (let i = 0; i < 150; i++) {
      particles.push({
        x: Math.random() * canvas.width,
        y: Math.random() * canvas.height - canvas.height,
        color: colors[Math.floor(Math.random() * colors.length)],
        size: Math.random() * 10 + 5,
        speedY: Math.random() * 3 + 2,
        speedX: Math.random() * 2 - 1,
        rotation: Math.random() * 360,
        rotationSpeed: Math.random() * 10 - 5
      });
    }

    let animationId: number;
    const animate = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      particles.forEach(p => {
        p.y += p.speedY;
        p.x += p.speedX;
        p.rotation += p.rotationSpeed;
        
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate((p.rotation * Math.PI) / 180);
        ctx.fillStyle = p.color;
        ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size);
        ctx.restore();

        if (p.y > canvas.height) p.y = -20;
      });
      animationId = requestAnimationFrame(animate);
    };
    animate();

    return () => cancelAnimationFrame(animationId);
  }, []);

  return <canvas ref={canvasRef} className="confetti-canvas" />;
});

const BombEffect = memo(({ text }: { text: string }) => {
  return (
    <div className="bomb-effect">
       <div className="bomb-text">{text}</div>
    </div>
  );
});

// --- GAME LOGIC CONTAINER ---

export default function GanDengYan() {
  const [state, setState] = useState<GameState>({
    status: "lobby",
    players: [],
    deck: [],
    tablePile: [],
    currentPlayerIndex: 0,
    lastWinnerIndex: 0,
    passesInARow: 0,
    bombCount: 0,
    scores: {}
  });
  
  const [selectedCardIds, setSelectedCardIds] = useState<string[]>([]);
  const [lastMessage, setLastMessage] = useState<string>("");
  const [lobbyStep, setLobbyStep] = useState<"MAIN" | "SELECT_COUNT">("MAIN");
  const [bombToast, setBombToast] = useState<string | null>(null);
  const [muted, setMuted] = useState(false);

  const aiTimeoutRef = useRef<number | null>(null);
  const msgTimeoutRef = useRef<number | null>(null);
  
  const toggleMute = () => {
    const next = !muted;
    setMuted(next);
    audio.muted = next;
    audio.init();
    audio.playClick();
  };

  const showMessage = useCallback((msg: string, duration: number = 0) => {
    setLastMessage(msg);
    if (msgTimeoutRef.current) clearTimeout(msgTimeoutRef.current);
    if (duration > 0) {
      msgTimeoutRef.current = window.setTimeout(() => setLastMessage(""), duration);
    }
  }, []);

  const triggerBombToast = useCallback((isKing: boolean) => {
    setBombToast(isKing ? "王炸！\n倍数翻倍！" : "炸弹！\n倍数翻倍！");
    audio.playBomb();
    setTimeout(() => setBombToast(null), 2000);
  }, []);

  const startGame = (count: number) => {
    audio.init();
    audio.playClick();
    const newDeck = shuffle(generateDeck());
    const players: Player[] = [];
    
    for (let i = 0; i < count; i++) {
      const isHuman = i === 0;
      players.push({
        id: i,
        name: isHuman ? "你" : `机器人${i}`,
        isAi: !isHuman,
        hand: [],
        cardsLeft: 0,
        hasPlayed: false,
        lastAction: null,
        role: "guest",
        color: isHuman ? "transparent" : BOT_COLORS[(i - 1) % BOT_COLORS.length]
      });
    }

    let dealerIndex = Math.floor(Math.random() * count);
    if (state.lastWinnerIndex >= 0 && state.lastWinnerIndex < count && state.status !== "lobby") {
      dealerIndex = state.lastWinnerIndex;
    }

    players.forEach((p, idx) => {
      const cardsToTake = idx === dealerIndex ? 6 : 5;
      p.hand = sortCards(newDeck.splice(0, cardsToTake));
      p.cardsLeft = p.hand.length;
      p.role = idx === dealerIndex ? "host" : "guest";
    });

    setState({
      status: "playing",
      players,
      deck: newDeck,
      tablePile: [],
      currentPlayerIndex: dealerIndex,
      lastWinnerIndex: dealerIndex,
      passesInARow: 0,
      bombCount: 0,
      scores: state.scores
    });
    
    audio.playDeal();
    showMessage(`游戏开始！${players[dealerIndex].name} 先出。`, 3000);
    setSelectedCardIds([]);
  };

  const calculateScores = useCallback((winnerIdx: number, players: Player[], bombs: number, oldScores: {[k:number]:number}) => {
    const multiplier = Math.pow(2, bombs);
    let totalWin = 0;
    const currentScores = { ...oldScores };

    players.forEach(p => {
      if (p.id === winnerIdx) return;
      let base = p.cardsLeft;
      if (base === 1) base = 0; 
      if (base === 5 && !p.hasPlayed) base = base * 2; 

      const penalty = base * multiplier;
      currentScores[p.id] = (currentScores[p.id] || 0) - penalty;
      totalWin += penalty;
    });

    currentScores[winnerIdx] = (currentScores[winnerIdx] || 0) + totalWin;
    return currentScores;
  }, []);

  const handleWin = useCallback((winnerIdx: number, finalBombCount: number, currentPlayers: Player[], lastHand: PlayedHand) => {
    audio.playWin();
    
    const scoresUpdate = calculateScores(winnerIdx, currentPlayers, finalBombCount, state.scores);

    setState(prev => ({ 
      ...prev, 
      status: "celebrating", 
      players: currentPlayers, 
      bombCount: finalBombCount, 
      lastWinnerIndex: winnerIdx,
      tablePile: [...prev.tablePile, lastHand] 
    }));
    
    setTimeout(() => {
      setState(prev => ({
        ...prev,
        status: "scoring",
        scores: scoresUpdate
      }));
    }, 4000);
  }, [state.scores, calculateScores]);

  const nextTurn = useCallback((passed: boolean) => {
    setState(currentState => {
        let nextIndex = (currentState.currentPlayerIndex + 1) % currentState.players.length;
        let nextPasses = passed ? currentState.passesInARow + 1 : 0;
        let nextDeck = [...currentState.deck];
        let nextPlayers = [...currentState.players];
        let roundWinner = currentState.lastWinnerIndex;

        // Visual
        nextPlayers[currentState.currentPlayerIndex].lastAction = passed ? "PASS" : "PLAY";

        // Round Over Check
        if (nextPasses >= currentState.players.length - 1) {
            const lastPlay = currentState.tablePile[currentState.tablePile.length - 1];
            if (lastPlay) roundWinner = lastPlay.playerId;
            
            showMessage(`${currentState.players[roundWinner].name} 赢了本轮！正在补牌...`, 2000);
            nextPlayers.forEach(p => p.lastAction = null);

            if (nextDeck.length > 0) {
                const drawnCard = nextDeck.shift()!;
                const winnerPlayer = nextPlayers[roundWinner];
                winnerPlayer.hand = sortCards([...winnerPlayer.hand, drawnCard]);
                winnerPlayer.cardsLeft = winnerPlayer.hand.length;
                audio.playDeal();
            } else {
                showMessage("牌堆空了！无法补牌。", 2000);
            }

            return {
                ...currentState,
                deck: nextDeck,
                players: nextPlayers,
                currentPlayerIndex: roundWinner, 
                lastWinnerIndex: roundWinner,
                passesInARow: 0,
                tablePile: [] 
            };
        } else {
            return {
                ...currentState,
                players: nextPlayers,
                currentPlayerIndex: nextIndex,
                passesInARow: nextPasses
            };
        }
    });
  }, [showMessage]);

  const playHand = useCallback((cards: Card[], analysis: any) => {
    audio.playCard();
    
    setState(prev => {
        const playerIndex = prev.currentPlayerIndex;
        const newPlayers = [...prev.players];
        const player = newPlayers[playerIndex];
        
        const cardIds = new Set(cards.map(c => c.id));
        player.hand = player.hand.filter(c => !cardIds.has(c.id));
        player.cardsLeft = player.hand.length;
        player.hasPlayed = true;
        player.lastAction = "PLAY";

        const isBomb = analysis.type === "BOMB" || analysis.type === "KING_BOMB";
        const newBombCount = prev.bombCount + (isBomb ? (analysis.type === "KING_BOMB" ? 1 : Math.max(1, analysis.bombLevel)) : 0);

        if (isBomb) triggerBombToast(analysis.type === "KING_BOMB");

        const playedHand: PlayedHand = {
            playerId: playerIndex,
            cards: cards,
            type: analysis.type,
            primaryRank: analysis.primaryRank,
            length: analysis.length,
            bombLevel: analysis.bombLevel
        };

        if (player.cardsLeft === 0) {
            handleWin(playerIndex, newBombCount, newPlayers, playedHand);
            return prev; // State update handled by handleWin
        }

        const nextIdx = (playerIndex + 1) % newPlayers.length;
        
        return {
            ...prev,
            players: newPlayers,
            tablePile: [...prev.tablePile, playedHand],
            lastWinnerIndex: playerIndex,
            passesInARow: 0,
            bombCount: newBombCount,
            currentPlayerIndex: nextIdx
        };
    });
    setSelectedCardIds([]);
  }, [handleWin, triggerBombToast]);

  // AI Turn Effect
  useEffect(() => {
    if (state.status !== "playing") return;

    const currentPlayer = state.players[state.currentPlayerIndex];
    if (currentPlayer.isAi) {
      aiTimeoutRef.current = window.setTimeout(() => {
        const lastHand = state.tablePile.length > 0 ? state.tablePile[state.tablePile.length - 1] : null;
        const result = calculateAiMove(currentPlayer.hand, lastHand);
        
        if (result) {
            playHand(result.cards, result.analysis);
        } else {
            audio.playPass();
            nextTurn(true);
        }
      }, 1000 + Math.random() * 500);
    }
    
    return () => {
      if (aiTimeoutRef.current) clearTimeout(aiTimeoutRef.current);
    };
  }, [state.currentPlayerIndex, state.status, state.players, state.tablePile, nextTurn, playHand]); 

  const handleUserPlay = () => {
    const player = state.players[0];
    const selectedCards = player.hand.filter(c => selectedCardIds.includes(c.id));
    
    const analysis = analyzeHand(selectedCards);
    if (!analysis) {
      showMessage("牌型无效！", 1500);
      return;
    }

    const lastHand = state.tablePile.length > 0 ? state.tablePile[state.tablePile.length - 1] : null;
    if (lastHand && !canBeat(analysis, lastHand)) {
      showMessage("打不过！需大一级。", 1500);
      return;
    }

    playHand(selectedCards, analysis);
  };

  const handleUserPass = () => {
    audio.playPass();
    if (state.tablePile.length === 0) {
      showMessage("你必须出牌，不能过！", 1500);
      return;
    }
    nextTurn(true);
    setSelectedCardIds([]);
  };

  const toggleCardSelect = useCallback((id: string) => {
    // Only allow selecting own cards when it's turn
    setState(prev => {
        if (prev.currentPlayerIndex !== 0) return prev;
        return prev;
    });
    
    // Check if it's actually user's turn in a separate check or trust UI state
    // We'll trust UI state for simplicity but only play sound
    audio.playClick();
    setSelectedCardIds(prev => 
      prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]
    );
  }, []);

  const getOpponentPositionStyle = (id: number, totalPlayers: number) => {
    if (totalPlayers === 2) return "pos-top";
    if (totalPlayers === 3) return id === 1 ? "pos-right" : "pos-left";
    if (totalPlayers === 4) {
        if (id === 1) return "pos-right";
        if (id === 2) return "pos-top";
        return "pos-left";
    }
    if (totalPlayers === 5) {
        if (id === 1) return "pos-right-low";
        if (id === 2) return "pos-right-high";
        if (id === 3) return "pos-left-high";
        return "pos-left-low";
    }
    if (totalPlayers === 6) {
        if (id === 1) return "pos-right-low";
        if (id === 2) return "pos-right-high";
        if (id === 3) return "pos-top";
        if (id === 4) return "pos-left-high";
        return "pos-left-low";
    }
    if (totalPlayers === 7) {
        if (id === 1) return "pos-right-low";
        if (id === 2) return "pos-right-high";
        if (id === 3) return "pos-top-right";
        if (id === 4) return "pos-top-left";
        if (id === 5) return "pos-left-high";
        return "pos-left-low";
    }
    return "pos-top";
  };

  // --- RENDER ---

  if (state.status === "lobby") {
    return (
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: "100%", background: "#1b5e20", gap: "20px" }}>
        <h1 style={{ fontSize: "4rem", color: "#fbc02d", textShadow: "2px 2px 4px black", margin: 0 }}>干瞪眼</h1>
        <h2 style={{ color: "#fff", opacity: 0.8 }}>Gan Deng Yan Poker</h2>
        
        <div style={{ background: "rgba(0,0,0,0.3)", padding: "30px", borderRadius: "10px", display: "flex", flexDirection: "column", gap: "10px", alignItems: "center", minWidth: "300px" }}>
          {lobbyStep === "MAIN" && (
            <div style={{ display: "flex", flexDirection: "column", gap: "20px", width: "100%", alignItems: "center" }}>
               <button 
                 onClick={() => { audio.init(); setLobbyStep("SELECT_COUNT"); audio.playClick(); }}
                 style={{ padding: "15px 40px", fontSize: "1.5rem", background: "#fbc02d", border: "none", borderRadius: "30px", cursor: "pointer", fontWeight: "bold", boxShadow: "0 4px 0 #f57f17", width: "240px" }}
               >
                 单机对战
               </button>
               <button 
                 disabled
                 style={{ padding: "15px 40px", fontSize: "1.5rem", background: "#757575", border: "none", borderRadius: "30px", cursor: "not-allowed", fontWeight: "bold", opacity: 0.7, width: "240px" }}
               >
                 多人联机
               </button>
            </div>
          )}

          {lobbyStep === "SELECT_COUNT" && (
             <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: "20px" }}>
                <h3 style={{ margin: 0 }}>选择人数</h3>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "10px" }}>
                   {[2,3,4,5,6,7].map(num => (
                     <button
                       key={num}
                       onClick={() => startGame(num)}
                       style={{ padding: "15px 20px", fontSize: "1.2rem", background: "#4caf50", border: "none", borderRadius: "10px", cursor: "pointer", fontWeight: "bold", color: "white" }}
                     >
                       {num}人
                     </button>
                   ))}
                </div>
                <button 
                  onClick={() => { setLobbyStep("MAIN"); audio.playClick(); }}
                  style={{ background: "transparent", border: "none", color: "#ccc", marginTop: "10px", cursor: "pointer", textDecoration: "underline" }}
                >
                  返回
                </button>
             </div>
          )}
        </div>
      </div>
    );
  }

  if (state.status === "scoring") {
     return (
        <div className="full-screen-overlay">
           <div style={{ 
               background: "#2c3e50", 
               borderRadius: "16px", 
               boxShadow: "0 10px 30px rgba(0,0,0,0.5)", 
               width: "90%", 
               maxWidth: "500px", 
               overflow: "hidden",
               border: "2px solid #f1c40f",
               display: "flex",
               flexDirection: "column",
               position: "relative"
           }}>
             <button
               onClick={() => { setState(prev => ({ ...prev, status: "lobby", scores: {} })); audio.playClick(); }}
               style={{
                 position: "absolute", top: "15px", right: "15px",
                 background: "rgba(0,0,0,0.2)", border: "none", color: "white",
                 width: "36px", height: "36px", borderRadius: "50%",
                 cursor: "pointer", fontSize: "20px", display: "flex",
                 alignItems: "center", justifyContent: "center", zIndex: 10
               }}
             >
               ✕
             </button>

             <div style={{ background: "#a06000", padding: "20px", textAlign: "center", color: "white", borderBottom: "1px solid #c98e1a" }}>
                 <h2 style={{ margin: 0, fontSize: "2rem", fontWeight: "900", textShadow: "1px 1px 0px rgba(0,0,0,0.2)" }}>本局分数结算</h2>
             </div>
             
             <div style={{ padding: "20px", background: "#2c3e50", flex: 1 }}>
               <div style={{ 
                   display: "grid", gridTemplateColumns: "1.2fr 1.5fr 60px 60px", gap: "10px", 
                   color: "#95a5a6", fontSize: "1rem", marginBottom: "15px", padding: "0 10px", 
                   fontWeight: "bold", borderBottom: "1px solid #34495e", paddingBottom: "10px"
               }}>
                  <span style={{ textAlign: "left" }}>玩家</span>
                  <span style={{ textAlign: "right" }}>详情</span>
                  <span style={{ textAlign: "right" }}>变动</span>
                  <span style={{ textAlign: "right" }}>总分</span>
               </div>
               
               <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                 {state.players.map(p => {
                    const totalScore = state.scores[p.id] || 0;
                    const multiplier = Math.pow(2, state.bombCount);
                    let roundScore = 0;
                    const isWinner = p.id === state.lastWinnerIndex;
                    let detailText = "";

                    if (isWinner) {
                       detailText = "赢家通吃";
                       let totalWin = 0;
                       state.players.forEach(loser => {
                           if (loser.id === state.lastWinnerIndex) return;
                           let base = loser.cardsLeft;
                           if (base === 1) base = 0; 
                           if (base === 5 && !loser.hasPlayed) base = base * 2; 
                           totalWin += base * multiplier;
                       });
                       roundScore = totalWin;
                    } else {
                       let base = p.cardsLeft;
                       let baseText = `剩${base}张`;
                       if (base === 1) { base = 0; baseText = `剩1张(免输)`; }
                       if (p.cardsLeft === 5 && !p.hasPlayed) { base = p.cardsLeft * 2; baseText = `全关x2`; }
                       roundScore = -1 * base * multiplier;
                       detailText = baseText;
                       if (multiplier > 1 && p.cardsLeft !== 1) detailText += ` x${multiplier}倍`;
                    }

                    return (
                       <div key={p.id} style={{ 
                           display: "grid", gridTemplateColumns: "1.2fr 1.5fr 60px 60px", gap: "10px", alignItems: "center",
                           background: isWinner ? "rgba(255, 193, 7, 0.2)" : "transparent",
                           padding: "10px 10px", borderRadius: "8px", borderBottom: "1px solid #34495e"
                       }}>
                         <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                            <span style={{ fontWeight: "bold", color: "white", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{p.name}</span>
                            {isWinner && <span style={{ fontSize: "1.2rem" }}>🏆</span>}
                         </div>
                         <div style={{ textAlign: "right", fontSize: "0.9rem", color: "#bdc3c7", whiteSpace: "nowrap" }}>{detailText}</div>
                         <div style={{ textAlign: "right", fontWeight: "bold", color: roundScore > 0 ? "#27ae60" : (roundScore < 0 ? "#e74c3c" : "#95a5a6"), fontSize: "1.1rem" }}>{roundScore > 0 ? "+" : ""}{roundScore}</div>
                         <div style={{ textAlign: "right", color: "white", fontSize: "1.1rem" }}>{totalScore}</div>
                       </div>
                    );
                 })}
               </div>
             </div>
             
             <div style={{ padding: "20px", textAlign: "center", background: "#2c3e50" }}>
                 <button 
                   onClick={() => startGame(state.players.length)}
                   style={{ padding: "15px 80px", fontSize: "1.3rem", cursor: "pointer", background: "#d4a017", border: "none", borderRadius: "10px", fontWeight: "bold", color: "white", boxShadow: "0 4px 0 #b38600" }}
                 >
                   下一局
                 </button>
             </div>
           </div>
        </div>
     );
  }

  const user = state.players[0];
  const opponents = state.players.filter(p => p.id !== 0);
  const cardCount = user.hand.length;
  const squeeze = cardCount <= 5 ? -40 : -40 - ((cardCount - 5) * 4);
  const cardOverlap = Math.max(-70, squeeze);

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", position: "relative", overflow: "hidden" }}>
      
      {/* Top Right Controls */}
      <div style={{ position: "absolute", top: "10px", right: "10px", zIndex: 50, display: "flex", gap: "10px" }}>
        <button
          onClick={toggleMute}
          aria-label="Toggle Sound"
          style={{ 
              background: "rgba(0,0,0,0.4)", color: "white", border: "2px solid white", borderRadius: "50%", 
              width: "40px", height: "40px", display: "flex", alignItems: "center", justifyContent: "center", 
              cursor: "pointer", fontSize: "16px", boxShadow: "0 2px 4px rgba(0,0,0,0.2)"
          }}
        >
          {muted ? "🔇" : "🔊"}
        </button>
        <button 
          onClick={() => { setState(prev => ({ ...prev, status: "lobby", scores: {} })); audio.playClick(); }}
          style={{ background: "rgba(0,0,0,0.4)", color: "white", border: "1px solid white", borderRadius: "20px", padding: "5px 15px", cursor: "pointer", height: "40px", fontWeight: "bold" }}
        >
          退出
        </button>
      </div>

      {/* Opponents Area */}
      <div style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: "180px", pointerEvents: "none" }}>
        {opponents.map((opp) => {
          const posClass = getOpponentPositionStyle(opp.id, state.players.length);
          return (
            <div key={opp.id} className={`opponent-container ${posClass}`} style={{ 
               opacity: state.currentPlayerIndex === opp.id ? 1 : 0.7,
               transform: state.currentPlayerIndex === opp.id ? "scale(1.15)" : "scale(1)",
               zIndex: 10 
            }}>
              <div style={{ position: "relative" }}>
                 <div style={{ width: "50px", height: "50px", borderRadius: "50%", background: opp.color, display: "flex", alignItems: "center", justifyContent: "center", border: state.currentPlayerIndex === opp.id ? "3px solid #fbc02d" : "2px solid #fff", color: "white", fontSize: "24px", boxShadow: "0 2px 4px rgba(0,0,0,0.3)" }}>🤖</div>
                 {opp.lastAction === "PASS" && <div className="pass-bubble">不要</div>}
              </div>
              <div style={{ background: "#fff", color: "#d32f2f", padding: "2px 8px", borderRadius: "10px", marginTop: "-10px", fontWeight: "bold", fontSize: "1.2rem", zIndex: 2, position: "relative", boxShadow: "0 1px 2px black" }}>{opp.cardsLeft}</div>
              <div style={{ fontSize: "0.8rem", marginTop: "4px", textShadow: "1px 1px 2px black", background: "rgba(0,0,0,0.5)", padding: "2px 4px", borderRadius: "4px" }}>{opp.name}</div>
            </div>
          );
        })}
      </div>

      {/* Main Table Area */}
      <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", position: "relative" }}>
        <div style={{ display: "flex", marginLeft: "-36px", transform: "scale(1.2)" }}>
          {state.tablePile.length === 0 ? (
             <div style={{ marginLeft: "36px", opacity: 0.3, border: "2px dashed #fff", width: "60px", height: "84px", borderRadius: "6px", display: "flex", alignItems: "center", justifyContent: "center" }}>空</div>
          ) : (
             state.tablePile[state.tablePile.length - 1].cards.map((c, i) => (
               <div key={c.id} style={{ marginLeft: i === 0 ? "36px" : "-36px", zIndex: i }}>
                  <CardView card={c} small />
               </div>
             ))
          )}
        </div>
        
        <div style={{ position: "absolute", bottom: "10px", background: "rgba(0,0,0,0.6)", padding: "8px 20px", borderRadius: "20px", border: "1px solid rgba(255,255,255,0.2)" }}>
           <span style={{ marginRight: "15px", color: "#e57373" }}>炸弹数: {state.bombCount}</span>
           <span style={{ color: "#fbc02d", fontWeight: "bold" }}>倍数: x{Math.pow(2, state.bombCount)}</span>
        </div>
        
        <div style={{ position: "absolute", top: "25%", background: "rgba(255,255,255,0.9)", color: "#000", padding: "8px 16px", borderRadius: "4px", fontWeight: "bold", display: lastMessage ? "block" : "none", maxWidth: "80%", textAlign: "center", boxShadow: "0 2px 10px rgba(0,0,0,0.3)" }}>
          {lastMessage}
        </div>
      </div>

      {/* User Area */}
      <div style={{ height: "180px", display: "flex", flexDirection: "column", justifyContent: "flex-end", paddingBottom: "10px", background: "linear-gradient(to top, rgba(0,0,0,0.6), transparent)", zIndex: 20, position: "relative" }}>
         
         <div style={{ display: "flex", justifyContent: "center", alignItems: "center", gap: "20px", marginBottom: "10px", position: "relative", width: "100%" }}>
            {user.lastAction === "PASS" && state.currentPlayerIndex !== 0 && (
                 <div className="pass-bubble" style={{ position: "absolute", top: "-40px", left: "50%", transform: "translateX(-50%)" }}>不要</div>
            )}

            {state.currentPlayerIndex === 0 && state.status === 'playing' && (
              <>
                <button 
                  onClick={handleUserPass}
                  disabled={state.tablePile.length === 0 && state.lastWinnerIndex === 0}
                  style={{ padding: "10px 30px", background: "#e0e0e0", border: "none", borderRadius: "20px", fontWeight: "bold", fontSize: "1rem", cursor: "pointer", boxShadow: "0 2px 0 #9e9e9e" }}
                >
                  不要
                </button>
                <button 
                  onClick={handleUserPlay} 
                  disabled={selectedCardIds.length === 0}
                  style={{ padding: "10px 30px", background: "#fbc02d", border: "none", borderRadius: "20px", fontWeight: "bold", fontSize: "1rem", opacity: selectedCardIds.length === 0 ? 0.5 : 1, cursor: "pointer", boxShadow: "0 2px 0 #f57f17" }}
                >
                  出牌
                </button>
              </>
            )}

             <div style={{ 
                 position: "absolute", top: "-15px", right: "5px", 
                 display: "flex", alignItems: "center", gap: "8px", 
                 background: "rgba(0,0,0,0.4)", padding: "5px 10px", borderRadius: "15px",
                 border: "1px solid rgba(255,255,255,0.3)", transform: "scale(0.85)", transformOrigin: "right center"
             }}>
                <div style={{ fontSize: "20px" }}>🂠</div>
                <span style={{ fontSize: "1rem", whiteSpace: "nowrap", fontWeight: "bold" }}>剩余 {state.deck.length}</span>
             </div>
         </div>

         <div style={{ display: "flex", justifyContent: "center", height: "130px", overflow: "visible" }}>
            <div style={{ display: "flex", marginLeft: "-40px" }}>
              {user.hand.map((card, i) => (
                <div key={card.id} style={{ marginLeft: i === 0 ? "40px" : `${cardOverlap}px`, zIndex: i }}>
                   <CardView 
                     card={card} 
                     selected={selectedCardIds.includes(card.id)} 
                     onClick={() => toggleCardSelect(card.id)}
                   />
                </div>
              ))}
            </div>
         </div>
      </div>

      {bombToast && <BombEffect text={bombToast} />}

      {state.status === "celebrating" && (
        <div style={{ position: "fixed", top: 0, left: 0, right: 0, bottom: 0, pointerEvents: "none", zIndex: 999 }}>
          <Confetti />
          <div className="animate-pop" style={{ position: "absolute", top: "50px", width: "100%", textAlign: "center" }}>
             <h1 style={{ fontSize: "4rem", color: "#fbc02d", textShadow: "0 0 10px red, 0 0 20px orange", margin: 0 }}>
               {state.players[state.lastWinnerIndex].name} 赢了!
             </h1>
          </div>
        </div>
      )}
    </div>
  );
}

const root = createRoot(document.getElementById("root")!);
root.render(<GanDengYan />);