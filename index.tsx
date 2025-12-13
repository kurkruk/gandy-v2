import React, { useState, useEffect, useRef, useCallback, memo } from "react";
import { createRoot } from "react-dom/client";
import Peer, { DataConnection } from "peerjs";

// --- TYPES & CONSTANTS ---

type Suit = "spades" | "hearts" | "clubs" | "diamonds" | "joker";
type Rank = 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15 | 16 | 17;

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
  peerId?: string; // For network identification
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
  status: "lobby" | "dealing" | "playing" | "celebrating" | "scoring" | "waiting";
  players: Player[];
  deck: Card[];
  tablePile: PlayedHand[];
  currentPlayerIndex: number;
  lastWinnerIndex: number;
  dealerId: number; // Persists for the whole round
  passesInARow: number;
  roundsFinishedAfterDeckEmpty: number; // Track stalemate
  bombCount: number;
  scores: { [playerId: number]: number };
  gameHistory: { [playerId: number]: number }[]; // Array of round deltas
  roomId?: string; // Multiplayer Room ID
  isHost?: boolean;
  myPlayerId?: number; // Which player am I?
}

// Network Payload Types
type NetworkAction = 
  | { type: "SYNC_STATE"; state: GameState }
  | { type: "PLAYER_JOIN"; name: string; peerId: string }
  | { type: "ACTION_PLAY"; cards: Card[]; analysis: any }
  | { type: "ACTION_PASS" }
  | { type: "HEARTBEAT" }
  | { type: "SHOW_MESSAGE"; text: string; duration: number }
  | { type: "START_GAME"; playerCount: number };

const SUITS: Suit[] = ["spades", "hearts", "clubs", "diamonds"];
const RANKS = [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]; 
const BOT_COLORS = ["#ef5350", "#ab47bc", "#5c6bc0", "#26c6da", "#66bb6a", "#ffa726", "#8d6e63"];
const BOT_AVATARS = ["🐼", "🐨", "🦊", "🐶", "🐱", "🐰", "🐹", "🐯"];
const APP_ID_PREFIX = "gdy-game-v1-"; // Unique prefix to avoid collision on public PeerServer
const STORAGE_KEY_NICKNAME = "gdy_saved_nickname"; // LocalStorage Key

// Tencent & Xiaomi STUN servers + Metered.ca TURN for global connectivity
const PEER_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.qq.com:3478' },     // Tencent
    { urls: 'stun:stun.miwifi.com:3478' }, // Xiaomi
    { urls: 'stun:stun.netease.com:3478' }, // Netease
    { urls: 'stun:stun.baidu.com:3478' },   // Baidu
    { urls: 'stun:stun.hitv.com' },
    { urls: 'stun:stun.l.google.com:19302' }, // Fallback
  ],
  sdpSemantics: 'unified-plan'
};

// --- AUDIO SYSTEM ---

class SoundManager {
  ctx: AudioContext | null = null;
  muted: boolean = false;
  voices: SpeechSynthesisVoice[] = [];

  init() {
    if (!this.ctx) {
      this.ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
    }
    if (this.ctx.state === 'suspended') {
      this.ctx.resume();
    }
    // Load voices
    if (typeof window !== 'undefined' && window.speechSynthesis) {
        const load = () => { this.voices = window.speechSynthesis.getVoices(); };
        load();
        window.speechSynthesis.onvoiceschanged = load;
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
  
  playPass() { 
    if (this.muted) return;
    if (typeof window !== 'undefined' && window.speechSynthesis) {
        window.speechSynthesis.cancel(); // Stop previous speech
        const phrases = ["不要", "过", "要不起"];
        const text = phrases[Math.floor(Math.random() * phrases.length)];
        const ut = new SpeechSynthesisUtterance(text);
        ut.lang = 'zh-CN';
        ut.rate = 1.3;
        
        // Try to find a Chinese voice
        const zhVoice = this.voices.find(v => v.lang.includes('zh-CN')) || this.voices.find(v => v.lang.includes('zh'));
        if (zhVoice) ut.voice = zhVoice;

        window.speechSynthesis.speak(ut);
    } else {
        this.playTone(200, 'sawtooth', 0.15, 0.05); 
    }
  }

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
  playDraw() {
      if (this.muted || !this.ctx) return;
      [300, 200, 100].forEach((f, i) => {
        setTimeout(() => this.playTone(f, 'sawtooth', 0.3, 0.1), i * 200);
      });
  }
}

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

  deck.push({ id: `c-${id++}`, suit: "joker", rank: 16, display: "小王" }); 
  deck.push({ id: `c-${id++}`, suit: "joker", rank: 17, display: "大王" }); 

  return deck;
};

const shuffle = (deck: Card[]) => {
  return [...deck].sort(() => Math.random() - 0.5);
};

const sortCards = (cards: Card[]) => {
  return [...cards].sort((a, b) => a.rank - b.rank);
};

const analyzeHand = (cards: Card[], targetRankHint?: number): { type: HandType; primaryRank: number; length: number; bombLevel: number } | null => {
  if (cards.length === 0) return null;
  const sorted = sortCards(cards);
  const len = sorted.length;
  const jokers = sorted.filter(c => c.suit === "joker");
  const normals = sorted.filter(c => c.suit !== "joker");
  const jokerCount = jokers.length;

  if (len === 2 && jokerCount === 2) return { type: "KING_BOMB", primaryRank: 17, length: 2, bombLevel: 99 };
  if (normals.length === 0) return null;

  const uniqueRanks = Array.from(new Set(normals.map(c => c.rank)));

  if (len === 1) {
    if (jokerCount > 0) return null;
    return { type: "SINGLE", primaryRank: sorted[0].rank, length: 1, bombLevel: 0 };
  }

  if (len === 2) {
    if (uniqueRanks.length === 1) return { type: "PAIR", primaryRank: normals[0].rank, length: 2, bombLevel: 0 };
    if (jokerCount === 1 && normals.length === 1) return { type: "PAIR", primaryRank: normals[0].rank, length: 2, bombLevel: 0 };
    return null;
  }

  if (len >= 3 && uniqueRanks.length === 1) {
    return { type: "BOMB", primaryRank: normals[0].rank, length: len, bombLevel: len - 2 };
  }

  if (len >= 3 && uniqueRanks.length === 1 && jokerCount > 0) {
      return { type: "BOMB", primaryRank: normals[0].rank, length: len, bombLevel: len - 2 };
  }

  if (len >= 3 && uniqueRanks.length > 1) {
    const validSeqs: number[][] = [];
    if (len >= 3) validSeqs.push([14, 15, ...Array.from({length: len-2}, (_, i) => 3+i)]); 
    if (len >= 3) validSeqs.push([15, ...Array.from({length: len-1}, (_, i) => 3+i)]); 
    
    for (let start = 3; start <= 14 - len + 1; start++) {
      if (start + len - 1 > 14) continue; 
      validSeqs.push(Array.from({length: len}, (_, i) => start + i));
    }

    const possibleInterpretations: { primaryRank: number }[] = [];

    for (const seq of validSeqs) {
       const seqSet = new Set(seq);
       const isSubset = normals.every(c => seqSet.has(c.rank));
       if (!isSubset) continue;
       if (uniqueRanks.length !== normals.length) continue;
       
       let virtualId = -1;
       if (seq[0] === 14 && seq[1] === 15) virtualId = 1;
       else if (seq[0] === 15 && seq[1] === 3) virtualId = 2;
       else virtualId = seq[0];
       
       possibleInterpretations.push({ primaryRank: virtualId });
    }

    if (possibleInterpretations.length > 0) {
        if (targetRankHint !== undefined) {
            const match = possibleInterpretations.find(p => p.primaryRank === targetRankHint);
            if (match) return { type: "STRAIGHT", primaryRank: match.primaryRank, length: len, bombLevel: 0 };
        }
        possibleInterpretations.sort((a, b) => b.primaryRank - a.primaryRank);
        return { type: "STRAIGHT", primaryRank: possibleInterpretations[0].primaryRank, length: len, bombLevel: 0 };
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

  if (move.type === "SINGLE" || move.type === "PAIR") {
    const isTwo = move.primaryRank === 15;
    const target = last.primaryRank + 1;
    if (move.primaryRank === target) return true;
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
    const normals = hand.filter(c => c.suit !== "joker");
    const jokers = hand.filter(c => c.suit === "joker");
    const lowNormals = normals.filter(c => c.rank < 15);
    const hasJoker = jokers.length > 0;

    const findSingle = (targetRank: number | null, limitToLow: boolean = false): Card[] | null => {
        const pool = limitToLow ? lowNormals : normals;
        for (const c of pool) {
            if (targetRank !== null) {
                if (c.rank === targetRank + 1) return [c];
                if (!limitToLow && c.rank === 15 && targetRank < 15) return [c]; // Use 2
            } else {
                return [c];
            }
        }
        if (targetRank === null && !limitToLow) {
             if (normals.length > 0) return [normals[0]];
             if (jokers.length > 0) return [jokers[0]];
        }
        return null;
    };

    const findPair = (targetRank: number | null, limitToLow: boolean = false): Card[] | null => {
        const groups: {[k:number]: Card[]} = {};
        const pool = limitToLow ? lowNormals : normals;
        pool.forEach(c => { if(!groups[c.rank]) groups[c.rank]=[]; groups[c.rank].push(c); });
        
        for (const rStr in groups) {
            const r = Number(rStr);
            if (groups[r].length >= 2) {
                if (targetRank !== null) {
                    if (r === targetRank + 1) return groups[r].slice(0, 2);
                    if (!limitToLow && r === 15 && targetRank < 15) return groups[r].slice(0, 2);
                } else {
                    return groups[r].slice(0, 2);
                }
            }
        }
        return null;
    };

    const findPairWithWild = (targetRank: number | null, limitToLow: boolean = false): Card[] | null => {
        if (!hasJoker) return null;
        const pool = limitToLow ? lowNormals : normals;
        for (const c of pool) {
             if (targetRank !== null) {
                 if (c.rank === targetRank + 1) return [c, jokers[0]];
                 if (!limitToLow && c.rank === 15 && targetRank < 15) return [c, jokers[0]];
             } else {
                 return [c, jokers[0]]; 
             }
        }
        return null;
    };

    const findStraight = (minLen: number, targetRank: number | null, limitToLow: boolean = false): Card[] | null => {
        const groups: {[k:number]: Card} = {};
        const pool = limitToLow ? lowNormals : normals;
        pool.forEach(c => groups[c.rank] = c);
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
                 if (current + minLen - 1 > 14) continue; 

                if (targetRank !== null) {
                    if (current === targetRank + 1) return seq;
                } else {
                    return seq;
                }
            }
        }
        return null;
    };
    
    const findStraightWithWild = (minLen: number, targetRank: number | null, limitToLow: boolean = false): Card[] | null => {
        if (!hasJoker) return null;
        const pool = limitToLow ? lowNormals : normals;
        const uniqueNormals = Array.from(new Set(pool.map(c => c.rank))).sort((a,b)=>a-b);
        
        let startRanks: number[] = [];
        if (targetRank !== null) {
            startRanks = [targetRank + 1];
        } else {
            startRanks = uniqueNormals;
        }

        for (const start of startRanks) {
            const desiredSeq = Array.from({length: minLen}, (_, i) => start + i);
            if (desiredSeq[desiredSeq.length-1] > 14) continue; 

            const found: Card[] = [];
            let missing = 0;
            for (const r of desiredSeq) {
                const c = pool.find(card => card.rank === r);
                if (c) found.push(c);
                else missing++;
            }

            if (missing === 1 && jokers.length >= 1) {
                return [...found, jokers[0]];
            }
        }
        return null;
    };

    const findBomb = (levelToBeat: number, rankToBeat: number): Card[] | null => {
        const groups: {[k:number]: Card[]} = {};
        hand.forEach(c => { if(c.suit !== 'joker') { if(!groups[c.rank]) groups[c.rank]=[]; groups[c.rank].push(c); }});
        
        if (jokers.length === 2 && (99 > levelToBeat)) return jokers;

        for (const rStr in groups) {
            const r = Number(rStr);
            const count = groups[r].length;
            const jokersAvailable = jokers.length;
            
            for (let jUsed = 0; jUsed <= jokersAvailable; jUsed++) {
                const totalCount = count + jUsed;
                if (totalCount >= 3) {
                    const bombLevel = totalCount - 2;
                    if (bombLevel > levelToBeat || (bombLevel === levelToBeat && r > rankToBeat)) {
                        return [...groups[r], ...jokers.slice(0, jUsed)];
                    }
                }
            }
        }
        return null;
    };
    
    const findBestBomb = (levelToBeat: number, rankToBeat: number) => {
         return findBomb(levelToBeat, rankToBeat);
    };

    let move: Card[] | null = null;
    let analysis: any = null;

    if (!lastHand) {
        move = findStraight(3, null, true);
        if (!move) move = findStraightWithWild(3, null, true);
        
        if (!move) move = findPair(null, true);
        if (!move) move = findPairWithWild(null, true);

        if (!move) move = findSingle(null, true);

        if (!move) {
             move = findStraight(3, null);
             if (!move) move = findStraightWithWild(3, null);
             
             if (!move) move = findPair(null);
             if (!move) move = findPairWithWild(null);
             
             if (!move) move = findSingle(null);
        }
        
        if (!move) {
             move = findBestBomb(-1, -1); 
        }
        if (!move && hand.length > 0) move = [hand[0]];

    } else {
        if (lastHand.type === "SINGLE") move = findSingle(lastHand.primaryRank);
        else if (lastHand.type === "PAIR") {
            move = findPair(lastHand.primaryRank);
            if (!move) move = findPairWithWild(lastHand.primaryRank);
        }
        else if (lastHand.type === "STRAIGHT") {
            move = findStraight(lastHand.length, lastHand.primaryRank);
            if (!move) move = findStraightWithWild(lastHand.length, lastHand.primaryRank);
        }

        if (!move && lastHand.type !== "KING_BOMB") {
            const lvl = lastHand.type === "BOMB" ? lastHand.bombLevel : 0;
            const rk = lastHand.type === "BOMB" ? lastHand.primaryRank : 0;
            move = findBestBomb(lvl, rk);
        }
    }

    if (move) {
        analysis = analyzeHand(move, lastHand && lastHand.type === 'STRAIGHT' ? lastHand.primaryRank + 1 : undefined);
        return { cards: move, analysis };
    }
    return null;
};

// --- COMPONENTS ---

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
           <div className="card-center" style={{ fontSize: small ? "1.5rem" : "2.5rem" }}>{suitIcon}</div>
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
    dealerId: 0,
    passesInARow: 0,
    roundsFinishedAfterDeckEmpty: 0,
    bombCount: 0,
    scores: {},
    gameHistory: []
  });
  
  const [selectedCardIds, setSelectedCardIds] = useState<string[]>([]);
  const [lastMessage, setLastMessage] = useState<string>("");
  const [lobbyStep, setLobbyStep] = useState<"MAIN" | "SELECT_COUNT" | "MULTI_LOBBY" | "JOIN_ROOM" | "NICKNAME">("MAIN");
  const [nickname, setNickname] = useState("");
  const [savedNickname, setSavedNickname] = useState<string | null>(null); // Persistence State
  const [bombToast, setBombToast] = useState<string | null>(null);
  const [muted, setMuted] = useState(false);
  const [showReport, setShowReport] = useState(false);
  const [loadingPlayerCount, setLoadingPlayerCount] = useState<number | null>(null);
  const [isAutoJoining, setIsAutoJoining] = useState(false);
  
  // Network State
  const [peer, setPeer] = useState<Peer | null>(null);
  const [myPeerId, setMyPeerId] = useState<string>("");
  const [connections, setConnections] = useState<DataConnection[]>([]);
  const connectionsRef = useRef<DataConnection[]>([]);
  const [joinRoomId, setJoinRoomId] = useState("");
  const [hostRoomId, setHostRoomId] = useState("");
  const [isConnecting, setIsConnecting] = useState(false);
  const [netLogs, setNetLogs] = useState<string[]>([]);

  const aiTimeoutRef = useRef<number | null>(null);
  const msgTimeoutRef = useRef<number | null>(null);
  const autoPassTimeoutRef = useRef<number | null>(null);

  const playHandRef = useRef<any>(null);
  const nextTurnRef = useRef<any>(null);
  const joinRoomRef = useRef<any>(null); // For auto-join

  useEffect(() => {
    connectionsRef.current = connections;
  }, [connections]);
  
  // Load saved nickname and handle auto-join via URL
  useEffect(() => {
      const stored = localStorage.getItem(STORAGE_KEY_NICKNAME);
      if (stored) {
          setSavedNickname(stored);
          setNickname(stored);
      }

      const params = new URLSearchParams(window.location.search);
      const roomParam = params.get("room");
      
      if (roomParam && roomParam.length === 4) {
          setJoinRoomId(roomParam);
          setIsAutoJoining(true);
          window.history.replaceState({}, document.title, window.location.pathname);
          
          if (stored) {
               // If we have a nickname and a room, join immediately
               // Use a timeout to ensure state is settled or refs are ready
               setTimeout(() => {
                   if (joinRoomRef.current) joinRoomRef.current(roomParam, stored);
               }, 500);
          } else {
               setLobbyStep("NICKNAME");
          }
      }
  }, []);

  const addLog = (msg: string) => {
      const time = new Date().toLocaleTimeString();
      setNetLogs(prev => [`[${time}] ${msg}`, ...prev].slice(0, 10)); 
  };
  
  const toggleMute = () => {
    const next = !muted;
    setMuted(next);
    audio.muted = next;
    audio.init();
    audio.playClick();
  };
  
  const saveNickname = (name: string) => {
      const cleanName = name.trim();
      if (!cleanName) return;
      localStorage.setItem(STORAGE_KEY_NICKNAME, cleanName);
      setSavedNickname(cleanName);
      setNickname(cleanName);
  };

  const clearSavedNickname = () => {
      localStorage.removeItem(STORAGE_KEY_NICKNAME);
      setSavedNickname(null);
      setNickname("");
  };
  
  const exitToLobby = () => {
      if (peer) {
          peer.destroy();
          setPeer(null);
      }
      setConnections([]);
      setNetLogs([]);
      setJoinRoomId("");
      setHostRoomId("");
      setIsConnecting(false);
      
      setState({
        status: "lobby",
        players: [],
        deck: [],
        tablePile: [],
        currentPlayerIndex: 0,
        lastWinnerIndex: 0,
        dealerId: 0,
        passesInARow: 0,
        roundsFinishedAfterDeckEmpty: 0,
        bombCount: 0,
        scores: {},
        gameHistory: []
      });
      setLobbyStep("MAIN");
      setBombToast(null);
      setSelectedCardIds([]);
      setShowReport(false);
      setLoadingPlayerCount(null);
      setIsAutoJoining(false);
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

  // --- NETWORK LOGIC ---

  const initNetwork = useCallback(() => {
    if (peer) return peer;
    addLog("初始化P2P网络...");
    
    const newPeer = new Peer(undefined, {
       config: PEER_CONFIG,
       debug: 1,
       secure: true
    });
    
    newPeer.on('open', (id) => {
      setMyPeerId(id);
      addLog("P2P网络就绪，ID获取成功");
    });
    
    newPeer.on('connection', (conn) => {
      addLog(`收到连接请求: ${conn.peer}`);
      conn.on('data', (data: any) => {
         handleNetworkData(data, conn);
      });
      conn.on('open', () => {
         addLog("连接通道已完全打开！");
         setConnections(prev => [...prev, conn]);
      });
      conn.on('error', (err) => addLog(`连接异常: ${err}`));
      conn.on('close', () => addLog("连接已关闭"));
    });

    newPeer.on('error', (err) => {
        if ((err.type === 'network' || err.type === 'peer-unavailable' || err.type === 'socket-closed') && connectionsRef.current.length > 0) {
            addLog(`(后台忽略) 信令波动: ${err.type}`);
            return;
        }
        addLog(`全局错误: ${err.type}`);
        showMessage(`网络错误: ${err.type}`, 3000);
        setIsConnecting(false);
    });

    setPeer(newPeer);
    return newPeer;
  }, [peer]);

  const handleNetworkData = (data: NetworkAction, conn: DataConnection) => {
      if (data.type === "SYNC_STATE") {
          setState(data.state);
          setIsConnecting(false);
          return;
      }
      if (data.type === "SHOW_MESSAGE") {
          showMessage(data.text, data.duration);
          return;
      }
      if (data.type === "HEARTBEAT") {
          return; 
      }
      if (data.type === "PLAYER_JOIN") {
         addLog(`玩家 ${data.name} 加入`);
         setGameState(prev => {
             const existingPlayer = prev.players.find(p => p.name === data.name);
             if (existingPlayer) {
                 addLog(`玩家 ${data.name} 重连成功`);
                 const updatedPlayers = prev.players.map(p => 
                     p.name === data.name ? { ...p, peerId: data.peerId } : p
                 );
                 const nextState = { ...prev, players: updatedPlayers };
                 if (conn.open) conn.send({ type: "SYNC_STATE", state: nextState });
                 return nextState;
             }
             if (prev.players.some(p => p.peerId === data.peerId)) return prev;

             const newPId = prev.players.length;
             const newPlayer: Player = {
                 id: newPId,
                 name: data.name,
                 isAi: false,
                 hand: [],
                 cardsLeft: 0,
                 hasPlayed: false,
                 lastAction: null,
                 role: 'guest',
                 color: BOT_COLORS[(newPId - 1) % BOT_COLORS.length],
                 peerId: data.peerId
             };
             const nextState = { ...prev, players: [...prev.players, newPlayer] };
             if (conn.open) conn.send({ type: "SYNC_STATE", state: nextState });
             
             return nextState;
         });
         return;
      }
      if (data.type === "ACTION_PLAY") {
          if (playHandRef.current) playHandRef.current(data.cards, data.analysis);
      }
      if (data.type === "ACTION_PASS") {
          if (nextTurnRef.current) nextTurnRef.current(true);
      }
  };

  const broadcastState = useCallback((newState: GameState) => {
      if (!newState.isHost) return;
      connectionsRef.current.forEach(conn => {
          if(conn.open) conn.send({ type: "SYNC_STATE", state: newState });
      });
  }, []);
  
  const broadcastMessage = useCallback((text: string, duration: number = 2000) => {
      connectionsRef.current.forEach(conn => {
          if(conn.open) conn.send({ type: "SHOW_MESSAGE", text, duration });
      });
  }, []);

  const setGameState = (updater: (prev: GameState) => GameState) => {
      setState(prev => {
          const next = updater(prev);
          if (next.isHost) {
             broadcastState(next);
          }
          return next;
      });
  };

  const createRoom = () => {
      addLog("正在创建房间...");
      if (peer) { peer.destroy(); setPeer(null); }
      setIsConnecting(true);
      
      setTimeout(() => {
          const simpleId = Math.floor(1000 + Math.random() * 9000).toString();
          const fullId = APP_ID_PREFIX + simpleId;
          
          addLog(`注册房间ID: ${simpleId}`);
          
          const hostPeer = new Peer(fullId, {
              config: PEER_CONFIG,
              secure: true
          });
          
          hostPeer.on('open', (id) => {
              setMyPeerId(id);
              setHostRoomId(simpleId);
              setIsConnecting(false);
              addLog("房间创建成功！等待玩家...");
              setState({
                  ...state,
                  status: "waiting",
                  isHost: true,
                  myPlayerId: 0,
                  roomId: simpleId,
                  players: [{
                      id: 0,
                      name: nickname || savedNickname || "房主",
                      isAi: false,
                      hand: [],
                      cardsLeft: 0,
                      hasPlayed: false,
                      lastAction: null,
                      role: 'host',
                      color: 'transparent',
                      peerId: id
                  }],
                  scores: {},
                  gameHistory: [],
                  passesInARow: 0,
                  roundsFinishedAfterDeckEmpty: 0,
                  tablePile: [],
                  deck: [],
                  currentPlayerIndex: 0,
                  lastWinnerIndex: 0,
                  dealerId: 0,
                  bombCount: 0
              });
          });
          
          hostPeer.on('connection', (conn) => {
              addLog(`有连接进入...`);
              conn.on('data', (d: any) => handleNetworkData(d, conn));
              conn.on('open', () => {
                 addLog(`与 ${conn.peer.slice(-4)} 握手成功！`);
                 setConnections(prev => [...prev, conn]);
              });
              conn.on('error', (e) => addLog(`Conn Err: ${e}`));
              
              // NEW: Handle disconnection (The Fix)
              conn.on('close', () => {
                  addLog(`连接断开: ${conn.peer.slice(-4)}`);
                  setConnections(prev => prev.filter(c => c.peer !== conn.peer));
                  
                  setGameState(prev => {
                      if (prev.status === 'waiting') {
                          const pName = prev.players.find(p => p.peerId === conn.peer)?.name || "玩家";
                          showMessage(`${pName} 已退出`, 2000);
                          const remaining = prev.players.filter(p => p.peerId !== conn.peer);
                          // Re-index
                          const reIndexed = remaining.map((p, idx) => ({ ...p, id: idx }));
                          return { ...prev, players: reIndexed };
                      }
                      return prev;
                  });
              });

              setTimeout(() => { if (!conn.open) conn.close(); }, 15000);
          });
          
          hostPeer.on('error', (e) => {
             addLog(`Host Error: ${e.type}`);
             setIsConnecting(false);
             if (e.type === 'unavailable-id') showMessage("ID冲突，请重试", 2000);
          });
          
          setPeer(hostPeer);
      }, 500);
  };
  
  const joinRoom = (roomIdOverride?: string, nameOverride?: string) => {
      const targetRoomId = roomIdOverride || joinRoomId;
      const targetName = nameOverride || nickname || "玩家";

      if (targetRoomId.length !== 4) {
          showMessage("请输入4位房间号", 1000);
          return;
      }
      setNetLogs([]);
      addLog(`正在查找房间: ${targetRoomId}...`);
      setIsConnecting(true);
      
      if (peer) { peer.destroy(); setPeer(null); }
      
      setTimeout(() => {
          const fullId = APP_ID_PREFIX + targetRoomId;
          const guestPeer = new Peer(undefined, {
              config: PEER_CONFIG,
              secure: true
          });
          
          guestPeer.on('open', (id) => {
              setMyPeerId(id);
              addLog("客户端就绪，发起连接...");
              
              const conn = guestPeer.connect(fullId, {
                  serialization: 'json'
              });
              
              const timeoutId = setTimeout(() => {
                  if (!conn.open) {
                      addLog("连接超时！请检查房间号或防火墙");
                      showMessage("连接超时，请重试", 3000);
                      setIsConnecting(false);
                  }
              }, 20000);

              conn.on('open', () => {
                 clearTimeout(timeoutId);
                 addLog("通道打开！发送加入请求...");
                 showMessage("已连接房主！", 1000);
                 conn.send({ type: "PLAYER_JOIN", name: targetName, peerId: id });
              });
              
              conn.on('data', (data: any) => {
                 if (data.type === "SYNC_STATE") {
                     const s = data.state as GameState;
                     const me = s.players.find(p => p.peerId === guestPeer.id); 
                     setState({ ...s, isHost: false, myPlayerId: me ? me.id : -1 });
                     setIsConnecting(false);
                 }
                 if (data.type === "SHOW_MESSAGE") {
                     showMessage(data.text, data.duration);
                 }
                 if (data.type === "HEARTBEAT") {
                     return; 
                 }
              });
              
              conn.on('close', () => {
                  clearTimeout(timeoutId);
                  addLog("连接已断开");
                  showMessage("连接断开", 3000);
                  setIsConnecting(false);
                  setState(prev => ({...prev, status: 'lobby'}));
              });
              
              conn.on('error', (e) => {
                  clearTimeout(timeoutId);
                  addLog(`连接异常: ${e}`);
                  setIsConnecting(false);
              });
              
              setConnections([conn]); 
          });
          
          guestPeer.on('error', (e) => {
              if ((e.type === 'network' || e.type === 'peer-unavailable') && connectionsRef.current.length > 0) return;
              addLog(`Guest Error: ${e.type}`);
              setIsConnecting(false);
              if (e.type === 'peer-unavailable') {
                  showMessage("房间不存在", 2000);
              } else {
                  showMessage("连接失败", 2000);
              }
          });
          
          setPeer(guestPeer);
      }, 500);
  };
  
  // Expose joinRoom to useEffect via ref to avoid stale closures
  useEffect(() => {
      joinRoomRef.current = joinRoom;
  }, [nickname, joinRoomId]); // Dependencies usually fine, but logic is inside function

  const copyInviteLink = () => {
      const url = `${window.location.protocol}//${window.location.host}${window.location.pathname}?room=${hostRoomId}`;
      navigator.clipboard.writeText(url).then(() => {
          showMessage("邀请链接已复制！", 2000);
      }).catch(err => {
          showMessage("复制失败", 2000);
      });
  };

  const dealAndPlay = (players: Player[], deck: Card[], dealerIdx: number, initialScores: {[k:number]:number}, initialHistory: {[k:number]:number}[]) => {
        players.forEach((p, idx) => {
          const cardsToTake = idx === dealerIdx ? 6 : 5;
          p.hand = sortCards(deck.splice(0, cardsToTake));
          p.cardsLeft = p.hand.length;
        });

        setGameState((prev) => ({
          status: "playing",
          players,
          deck,
          tablePile: [],
          currentPlayerIndex: dealerIdx,
          lastWinnerIndex: dealerIdx,
          dealerId: dealerIdx,
          passesInARow: 0,
          roundsFinishedAfterDeckEmpty: 0,
          bombCount: 0,
          scores: initialScores,
          gameHistory: initialHistory,
          isHost: prev.isHost !== undefined ? prev.isHost : true, 
          myPlayerId: prev.myPlayerId !== undefined ? prev.myPlayerId : 0
        }));
        
        audio.playDeal();
        const msg = initialHistory.length === 0 
           ? `${players[dealerIdx].name} 成为首局随机庄家`
           : `${players[dealerIdx].name} 赢得上局，优先出牌`;
        showMessage(msg, 3000);
        broadcastMessage(msg);
        setSelectedCardIds([]);
  }

  const startGame = (count: number, scoreOverride?: {[k:number]:number}) => {
    audio.init();
    audio.playClick();
    const newDeck = shuffle(generateDeck());
    
    let players: Player[] = [];
    
    const shouldPreservePlayers = state.status === "waiting" || state.status === "scoring" || state.status === "celebrating" || state.status === "playing";
    let scoresToKeep: {[k:number]:number} = scoreOverride || {};
    let historyToKeep: {[k:number]:number}[] = [];

    if (shouldPreservePlayers) {
        players = state.players.map(p => ({
            ...p,
            hand: [],
            cardsLeft: 0,
            hasPlayed: false,
            lastAction: null
        }));
        
        if (state.status === "scoring" || state.status === "celebrating" || state.status === "playing") {
             if (!scoreOverride) {
                scoresToKeep = state.scores;
             }
             historyToKeep = state.gameHistory;
        }

        if (state.status === "waiting" && players.length < 2) {
            showMessage("至少需要2人", 1000);
            return;
        }
    } else {
        for (let i = 0; i < count; i++) {
          const isHuman = i === 0;
          players.push({
            id: i,
            name: isHuman ? (savedNickname || nickname || "你") : `bot${i}`,
            isAi: !isHuman,
            hand: [],
            cardsLeft: 0,
            hasPlayed: false,
            lastAction: null,
            role: "guest",
            color: isHuman ? "transparent" : BOT_COLORS[(i - 1) % BOT_COLORS.length]
          });
        }
    }

    if (state.status === 'lobby' || state.status === 'waiting' || state.lastWinnerIndex === -1) {
        const dealerIdx = Math.floor(Math.random() * players.length);
        dealAndPlay(players, newDeck, dealerIdx, scoresToKeep, historyToKeep);
        return;
    }

    let dealerIndex = 0;
    if (state.lastWinnerIndex >= 0 && state.lastWinnerIndex < players.length) {
      dealerIndex = state.lastWinnerIndex;
    }
    dealAndPlay(players, newDeck, dealerIndex, scoresToKeep, historyToKeep);
  };

  const calculateScores = useCallback((winnerIdx: number, players: Player[], bombs: number, oldScores: {[k:number]:number}) => {
    const multiplier = Math.pow(2, bombs);
    let totalWin = 0;
    const currentScores = { ...oldScores };
    const roundDeltas: {[k:number]:number} = {};

    players.forEach(p => {
      let change = 0;
      if (p.id !== winnerIdx) {
          let base = p.cardsLeft;
          if (base === 1) base = 0; 
          if (base === 5 && !p.hasPlayed) base = base * 2; 

          const penalty = base * multiplier;
          change = -penalty;
          totalWin += penalty;
      }
      roundDeltas[p.id] = change;
      currentScores[p.id] = (currentScores[p.id] || 0) + change;
    });

    roundDeltas[winnerIdx] = totalWin;
    currentScores[winnerIdx] = (currentScores[winnerIdx] || 0) + totalWin;
    
    return { currentScores, roundDeltas };
  }, []);

  const handleWin = useCallback((winnerIdx: number, finalBombCount: number, currentPlayers: Player[], lastHand: PlayedHand) => {
    audio.playWin();
    const { currentScores, roundDeltas } = calculateScores(winnerIdx, currentPlayers, finalBombCount, state.scores);

    setGameState(prev => ({ 
      ...prev, 
      status: "celebrating", 
      players: currentPlayers, 
      bombCount: finalBombCount, 
      lastWinnerIndex: winnerIdx, 
      tablePile: [...prev.tablePile, lastHand] 
    }));
    
    setTimeout(() => {
      setGameState(prev => ({
        ...prev,
        status: "scoring",
        scores: currentScores,
        gameHistory: [...prev.gameHistory, roundDeltas]
      }));
    }, 4000);
  }, [state.scores, calculateScores]);

  const handleDraw = useCallback(() => {
      audio.playDraw();
      const msg = "🚫 本局流产！下一局随机指定先手！";
      showMessage(msg, 3000);
      broadcastMessage(msg, 3000);

      const zeroDeltas: {[k:number]:number} = {};
      state.players.forEach(p => zeroDeltas[p.id] = 0);

      setGameState(prev => ({
          ...prev,
          lastWinnerIndex: -1,
          status: "scoring", 
          gameHistory: [...prev.gameHistory, zeroDeltas]
      }));
  }, [state.scores, state.players, showMessage, broadcastMessage]);

  const nextTurn = useCallback((passed: boolean) => {
    setGameState(currentState => {
        let nextIndex = (currentState.currentPlayerIndex + 1) % currentState.players.length;
        let nextPasses = passed ? currentState.passesInARow + 1 : 0;
        let nextDeck = [...currentState.deck];
        let nextPlayers = [...currentState.players];
        let roundWinner = currentState.lastWinnerIndex;
        let nextRoundsFinishedAfterDeckEmpty = currentState.roundsFinishedAfterDeckEmpty;

        if (nextPasses < currentState.players.length - 1) {
             nextPlayers[currentState.currentPlayerIndex].lastAction = passed ? "PASS" : "PLAY";
        }

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
                nextRoundsFinishedAfterDeckEmpty += 1;
            }
            
            if (nextRoundsFinishedAfterDeckEmpty >= 2) {
                setTimeout(() => handleDraw(), 0); 
                return currentState; 
            }

            return {
                ...currentState,
                deck: nextDeck,
                players: nextPlayers,
                currentPlayerIndex: roundWinner, 
                lastWinnerIndex: roundWinner,
                passesInARow: 0,
                roundsFinishedAfterDeckEmpty: nextRoundsFinishedAfterDeckEmpty,
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
  }, [showMessage, handleDraw]);

  const playHand = useCallback((cards: Card[], analysis: any) => {
    audio.playCard();
    
    setGameState(prev => {
        const playerIndex = prev.currentPlayerIndex;
        const newPlayers = [...prev.players];
        const player = { ...newPlayers[playerIndex] };
        newPlayers[playerIndex] = player;
        
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
            return prev; 
        }

        const nextIdx = (playerIndex + 1) % newPlayers.length;
        
        return {
            ...prev,
            players: newPlayers,
            tablePile: [...prev.tablePile, playedHand],
            lastWinnerIndex: playerIndex,
            passesInARow: 0,
            roundsFinishedAfterDeckEmpty: 0, 
            bombCount: newBombCount,
            currentPlayerIndex: nextIdx
        };
    });
    setSelectedCardIds([]);
  }, [handleWin, triggerBombToast]);

  useEffect(() => {
      playHandRef.current = playHand;
      nextTurnRef.current = nextTurn;
  }, [playHand, nextTurn]);

  useEffect(() => {
      if (!state.isHost) return;
      const interval = setInterval(() => {
          connectionsRef.current.forEach(conn => {
              if(conn.open) conn.send({ type: "HEARTBEAT" });
          });
      }, 3000);
      return () => clearInterval(interval);
  }, [state.isHost]);
  
  useEffect(() => {
      if (state.isHost) return;
      if (state.status === "lobby") return;
      const interval = setInterval(() => {
          connectionsRef.current.forEach(conn => {
              if(conn.open) conn.send({ type: "HEARTBEAT" });
          });
      }, 3000);
      return () => clearInterval(interval);
  }, [state.isHost, state.status]);

  useEffect(() => {
      if (state.isHost && state.status === 'playing') {
          [500, 1500].forEach(delay => {
              setTimeout(() => broadcastState(state), delay);
          });
      }
  }, [state.status, state.isHost, broadcastState]);

  useEffect(() => {
    if (state.status !== 'playing') return;
    const myId = state.myPlayerId || 0;
    if (state.currentPlayerIndex !== myId) return;

    return () => {
        if (autoPassTimeoutRef.current) {
            clearTimeout(autoPassTimeoutRef.current);
            autoPassTimeoutRef.current = null;
        }
    };
  }, [state.currentPlayerIndex, state.status, state.myPlayerId]);

  useEffect(() => {
      if (state.status !== 'playing') return;
      const myId = state.myPlayerId || 0;
      if (state.currentPlayerIndex !== myId) return;
      
      const me = state.players[myId];
      if (me.isAi) return;

      const lastHand = state.tablePile.length > 0 ? state.tablePile[state.tablePile.length - 1] : null;

      if (lastHand) {
          const bestMove = calculateAiMove(me.hand, lastHand);

          if (bestMove) {
              setSelectedCardIds(bestMove.cards.map(c => c.id));
          } else {
              showMessage("无牌可出，自动过...", 1000);
              autoPassTimeoutRef.current = window.setTimeout(() => {
                  handleUserPass();
              }, 1000);
          }
      }
  }, [state.currentPlayerIndex, state.status, state.myPlayerId, state.tablePile]);

  useEffect(() => {
    if (state.status !== "playing") return;
    if (!state.isHost) return;

    const currentPlayer = state.players[state.currentPlayerIndex];
    if (currentPlayer.isAi) {
      aiTimeoutRef.current = window.setTimeout(() => {
        const lastHand = state.tablePile.length > 0 ? state.tablePile[state.tablePile.length - 1] : null;
        const result = calculateAiMove(currentPlayer.hand, lastHand);
        
        if (result) {
            playHand(result.cards, result.analysis);
        } else {
            const willClearRound = state.passesInARow + 1 >= state.players.length - 1;
            if (!willClearRound) {
                audio.playPass();
            }
            nextTurn(true);
        }
      }, 1000 + Math.random() * 500);
    }
    
    return () => {
      if (aiTimeoutRef.current) clearTimeout(aiTimeoutRef.current);
    };
  }, [state.currentPlayerIndex, state.status, state.players, state.tablePile, nextTurn, playHand, state.isHost, state.passesInARow]); 

  const handleUserPlay = () => {
    const me = state.players[state.myPlayerId || 0];
    const selectedCards = me.hand.filter(c => selectedCardIds.includes(c.id));
    
    const lastHand = state.tablePile.length > 0 ? state.tablePile[state.tablePile.length - 1] : null;
    
    const hintRank = lastHand && lastHand.type === 'STRAIGHT' ? lastHand.primaryRank + 1 : undefined;
    const analysis = analyzeHand(selectedCards, hintRank);

    if (!analysis) { showMessage("牌型无效！", 1500); return; }

    if (lastHand && !canBeat(analysis, lastHand)) { showMessage("打不过！需大一级。", 1500); return; }

    if (state.isHost) {
        playHand(selectedCards, analysis);
    } else {
        connections[0].send({ type: "ACTION_PLAY", cards: selectedCards, analysis });
        setSelectedCardIds([]);
    }
  };

  const handleUserPass = () => {
    if (state.tablePile.length === 0) { showMessage("你必须出牌，不能过！", 1500); return; }
    
    const willClearRound = state.passesInARow + 1 >= state.players.length - 1;
    if (!willClearRound) {
        audio.playPass();
    }
    
    if (state.isHost) {
        nextTurn(true);
    } else {
        connections[0].send({ type: "ACTION_PASS" });
    }
    setSelectedCardIds([]);
  };

  const toggleCardSelect = useCallback((id: string) => {
    if (state.currentPlayerIndex !== (state.myPlayerId || 0)) return;
    audio.playClick();
    setSelectedCardIds(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
  }, [state.currentPlayerIndex, state.myPlayerId]);

  const getOpponentPositionStyle = (id: number, totalPlayers: number) => {
    const myId = state.myPlayerId || 0;
    const visualId = (id - myId + totalPlayers) % totalPlayers;
    
    if (totalPlayers === 2) return "pos-top";
    
    if (totalPlayers === 3) {
        return visualId === 1 ? "pos-right" : "pos-left";
    }
    
    if (totalPlayers === 4) {
        if (visualId === 1) return "pos-right";
        if (visualId === 2) return "pos-top";
        return "pos-left";
    }
    
    if (totalPlayers === 5) {
        if (visualId === 1) return "pos-right-low";
        if (visualId === 2) return "pos-right-high";
        if (visualId === 3) return "pos-left-high";
        return "pos-left-low";
    }
    
    if (totalPlayers === 6) {
        if (visualId === 1) return "pos-right-low";
        if (visualId === 2) return "pos-right-high";
        if (visualId === 3) return "pos-top";
        if (visualId === 4) return "pos-left-high";
        return "pos-left-low";
    }
    
    if (totalPlayers === 7) {
        if (visualId === 1) return "pos-right-low";
        if (visualId === 2) return "pos-right-high";
        if (visualId === 3) return "pos-top-right";
        if (visualId === 4) return "pos-top-left";
        if (visualId === 5) return "pos-left-high";
        return "pos-left-low";
    }
    return "pos-top";
  };
  
  const getAnimClass = (pid: number) => {
      if (pid === myId) return "anim-slide-bottom";
      const pos = getOpponentPositionStyle(pid, state.players.length);
      
      switch (pos) {
          case "pos-top-left": return "anim-slide-top-left";
          case "pos-top-right": return "anim-slide-top-right";
          case "pos-left-high": return "anim-slide-left-high";
          case "pos-left-low": return "anim-slide-left-low";
          case "pos-right-high": return "anim-slide-right-high";
          case "pos-right-low": return "anim-slide-right-low";
          case "pos-left": return "anim-slide-left";
          case "pos-right": return "anim-slide-right";
          case "pos-top": return "anim-slide-top";
          default: return "anim-slide-top";
      }
  };
  
  const copyReportToClipboard = () => {
      let text = "🂠 干瞪眼战绩表 🂠\n------------------\n";
      state.players.forEach(p => {
         const total = state.scores[p.id] || 0;
         const history = state.gameHistory.map((h, i) => `R${i+1}:${h[p.id] > 0 ? '+' : ''}${h[p.id]}`).join(', ');
         text += `${p.id + 1}. ${p.name}: ${total > 0 ? '+' : ''}${total} (${history})\n`;
      });
      text += "------------------\n总局数: " + state.gameHistory.length;
      
      navigator.clipboard.writeText(text).then(() => {
          showMessage("已复制到剪贴板！", 1500);
      }).catch(err => {
          console.error(err);
          showMessage("复制失败，请截图", 1500);
      });
  };

  const myId = state.myPlayerId || 0;
  const user = state.players[myId] || { hand: [], lastAction: null }; 
  const isDealer = state.dealerId === myId;

  if (state.status === "lobby" || state.status === "waiting") {
    return (
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: "100%", background: "#105e3c", gap: "20px" }}>
        <h1 style={{ fontSize: "4rem", color: "#fbc02d", textShadow: "2px 2px 4px black", margin: 0 }}>干瞪眼</h1>
        <h2 style={{ color: "#fff", opacity: 0.6, fontSize: "1.2rem", marginTop: "-10px", fontWeight: "normal" }}>BONJOY 特别定制版</h2>
        
        <div style={{ background: "rgba(0,0,0,0.3)", padding: "30px", borderRadius: "10px", display: "flex", flexDirection: "column", gap: "10px", alignItems: "center", minWidth: "300px", maxWidth: "450px", overflow: "hidden" }}>
          
          {state.status === "waiting" ? (
             <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: "15px", width: "100%" }}>
                <h3 style={{ margin: 0, color: "#fff", opacity: 0.8 }}>房间号</h3>
                <div style={{ background: "transparent", padding: "10px", border: "3px dashed #fbc02d", borderRadius: "10px" }}>
                    <h1 style={{ margin: 0, fontSize: "6rem", color: "#fbc02d", letterSpacing: "5px", lineHeight: 1 }}>{hostRoomId}</h1>
                </div>
                {state.isHost && (
                    <button 
                        onClick={copyInviteLink} 
                        style={{ padding: "8px 15px", background: "#0288d1", border: "none", borderRadius: "5px", fontSize: "0.9rem", color: "white", cursor: "pointer", marginTop: "-5px" }}
                    >
                        🔗 复制邀请链接
                    </button>
                )}
                {isConnecting && <div style={{color: "#fbc02d", fontWeight: "bold"}}>正在连接中...</div>}

                <div style={{ color: "#ddd", marginTop: "10px" }}>已加入玩家 ({state.players.length}人):</div>
                
                <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: "10px", width: "100%", maxHeight: "200px", overflowY: "auto" }}>
                    {state.players.map(p => (
                        <div key={p.id} style={{ background: "rgba(255,255,255,0.2)", padding: "10px 5px", borderRadius: "8px", display: "flex", flexDirection: "column", alignItems: "center", gap: "5px" }}>
                            <div style={{ fontSize: "2rem" }}>{BOT_AVATARS[(p.id - 1) % BOT_AVATARS.length]}</div>
                            <div style={{ fontSize: "0.9rem", color: "white", fontWeight: "bold", textAlign: "center", width: "100%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.name}</div>
                            {p.id === 0 && <span style={{ fontSize: "0.8rem", color: "#fbc02d" }}>👑 房主</span>}
                        </div>
                    ))}
                </div>

                {state.isHost ? (
                    <button onClick={() => startGame(0)} style={{ padding: "10px 30px", background: "#4caf50", border: "none", borderRadius: "20px", fontSize: "1.2rem", color: "white", marginTop: "10px" }}>开始游戏</button>
                ) : (
                    <div style={{ color: "#aaa" }}>等待房主开始...</div>
                )}
                <button onClick={exitToLobby} style={{ color: "#ccc", background: "none", border: "none", textDecoration: "underline" }}>退出</button>
                
                <div style={{ width: "100%", background: "rgba(0,0,0,0.8)", color: "#0f0", fontFamily: "monospace", fontSize: "10px", padding: "5px", borderRadius: "4px", height: "80px", overflowY: "auto", marginTop: "10px" }}>
                    {netLogs.map((log, i) => <div key={i}>{log}</div>)}
                </div>
             </div>
          ) : (
          <>
          {lobbyStep === "MAIN" && (
            <div style={{ display: "flex", flexDirection: "column", gap: "20px", width: "100%", alignItems: "center" }}>
               {savedNickname && (
                   <div style={{ background: "rgba(0,0,0,0.4)", padding: "10px 20px", borderRadius: "20px", display: "flex", flexDirection: "column", alignItems: "center", marginBottom: "10px" }}>
                       <div style={{ fontSize: "0.9rem", color: "#bdc3c7" }}>当前身份</div>
                       <div style={{ fontSize: "1.2rem", fontWeight: "bold", color: "#fbc02d" }}>{savedNickname}</div>
                       <button onClick={clearSavedNickname} style={{ marginTop: "5px", background: "transparent", border: "none", color: "#4fc3f7", fontSize: "0.8rem", cursor: "pointer", textDecoration: "underline" }}>切换账号</button>
                   </div>
               )}

               <button 
                 onClick={() => { audio.init(); setLobbyStep("SELECT_COUNT"); audio.playClick(); }}
                 style={{ padding: "15px 40px", fontSize: "1.5rem", background: "#fbc02d", border: "none", borderRadius: "30px", cursor: "pointer", fontWeight: "bold", boxShadow: "0 4px 0 #f57f17", width: "240px" }}
               >
                 单机对战
               </button>
               <button 
                 onClick={() => { 
                     audio.init(); 
                     audio.playClick();
                     if (savedNickname) {
                         setNickname(savedNickname);
                         setLobbyStep("MULTI_LOBBY");
                     } else {
                         setLobbyStep("NICKNAME"); 
                     }
                 }}
                 style={{ padding: "15px 40px", fontSize: "1.5rem", background: "#039be5", border: "none", borderRadius: "30px", cursor: "pointer", fontWeight: "bold", boxShadow: "0 4px 0 #0277bd", width: "240px", color: "white" }}
               >
                 多人联机
               </button>
            </div>
          )}

          {lobbyStep === "SELECT_COUNT" && (
             <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: "20px" }}>
                <h3 style={{ margin: 0 }}>选择游戏人数</h3>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "10px" }}>
                   {[2,3,4,5,6,7].map(num => {
                     const isLoading = loadingPlayerCount === num;
                     return (
                       <button
                         key={num}
                         onClick={() => {
                             if (loadingPlayerCount !== null) return;
                             audio.playClick();
                             setLoadingPlayerCount(num);
                             setTimeout(() => startGame(num), 300); 
                         }}
                         style={{ 
                             padding: "15px 20px", 
                             fontSize: "1.2rem", 
                             background: isLoading ? "#388e3c" : "#4caf50", 
                             border: isLoading ? "2px solid rgba(255,255,255,0.3)" : "none", 
                             borderRadius: "10px", 
                             cursor: "pointer", 
                             fontWeight: "bold", 
                             color: "white",
                             transform: isLoading ? "translateY(4px)" : "translateY(0)",
                             boxShadow: isLoading ? "none" : "0 4px 0 #2e7d32",
                             transition: "all 0.1s"
                         }}
                       >
                         {isLoading ? "..." : `${num}人`}
                       </button>
                     );
                   })}
                </div>
                <button onClick={() => setLobbyStep("MAIN")} style={{ background: "transparent", border: "none", color: "#ccc", marginTop: "10px", textDecoration: "underline" }}>返回</button>
             </div>
          )}

          {lobbyStep === "NICKNAME" && (
              <div style={{ display: "flex", flexDirection: "column", gap: "15px", alignItems: "center" }}>
                  <h3 style={{ margin: 0 }}>请输入昵称</h3>
                  <input 
                    type="text" placeholder="你的名字" 
                    value={nickname} onChange={e => setNickname(e.target.value.slice(0, 8))}
                    style={{ padding: "10px", fontSize: "1.5rem", width: "200px", textAlign: "center", borderRadius: "5px", border: "none" }}
                  />
                  <div style={{fontSize: "0.8rem", color: "#aaa"}}>设置后会自动记住</div>
                  <button 
                    onClick={() => { 
                        if(!nickname.trim()) { showMessage("请输入昵称", 1000); return; }
                        saveNickname(nickname);
                        if (isAutoJoining) {
                            joinRoom();
                        } else {
                            setLobbyStep("MULTI_LOBBY"); 
                        }
                    }} 
                    disabled={isConnecting}
                    style={{ 
                        padding: "10px 30px", 
                        background: isConnecting ? "#ccc" : "#fbc02d", 
                        border: "none", 
                        borderRadius: "20px", 
                        fontSize: "1.2rem", 
                        fontWeight: "bold",
                        cursor: isConnecting ? "not-allowed" : "pointer" 
                    }}
                  >
                    {isConnecting ? "连接中..." : (isAutoJoining ? "加入房间" : "下一步")}
                  </button>
                  {!isConnecting && (
                    <button onClick={() => setLobbyStep("MAIN")} style={{ background: "transparent", border: "none", color: "#ccc", textDecoration: "underline" }}>返回</button>
                  )}
                  
                  <div style={{ width: "100%", background: "rgba(0,0,0,0.8)", color: "#0f0", fontFamily: "monospace", fontSize: "10px", padding: "5px", borderRadius: "4px", height: "80px", overflowY: "auto", marginTop: "5px" }}>
                    {netLogs.length === 0 && <div style={{color: "#555"}}>网络日志...</div>}
                    {netLogs.map((log, i) => <div key={i}>{log}</div>)}
                  </div>
              </div>
          )}

          {lobbyStep === "MULTI_LOBBY" && (
              <div style={{ display: "flex", flexDirection: "column", gap: "15px", width: "100%", alignItems: "center" }}>
                  <div style={{color: "#fff", marginBottom: "5px"}}>你好，{nickname}</div>
                  <button 
                    onClick={createRoom} 
                    disabled={isConnecting}
                    style={{ padding: "15px 40px", fontSize: "1.3rem", background: isConnecting ? "#8bc34a88" : "#8bc34a", border: "none", borderRadius: "30px", width: "240px", cursor: isConnecting ? "wait" : "pointer" }}
                  >
                      {isConnecting ? "创建中..." : "创建房间"}
                  </button>
                  <button 
                    onClick={() => setLobbyStep("JOIN_ROOM")} 
                    disabled={isConnecting}
                    style={{ padding: "15px 40px", fontSize: "1.3rem", background: "#ff7043", border: "none", borderRadius: "30px", width: "240px" }}
                  >
                      加入房间
                  </button>
                  <button onClick={() => setLobbyStep("MAIN")} style={{ background: "transparent", border: "none", color: "#ccc", textDecoration: "underline" }}>返回</button>
                  
                  <div style={{ width: "100%", background: "rgba(0,0,0,0.8)", color: "#0f0", fontFamily: "monospace", fontSize: "10px", padding: "5px", borderRadius: "4px", height: "80px", overflowY: "auto", marginTop: "5px" }}>
                    {netLogs.length === 0 && <div style={{color: "#555"}}>网络日志...</div>}
                    {netLogs.map((log, i) => <div key={i}>{log}</div>)}
                  </div>
              </div>
          )}

          {lobbyStep === "JOIN_ROOM" && (
              <div style={{ display: "flex", flexDirection: "column", gap: "15px", alignItems: "center" }}>
                  <input 
                    type="number" placeholder="输入4位房间号" 
                    value={joinRoomId} onChange={e => setJoinRoomId(e.target.value)}
                    style={{ padding: "10px", fontSize: "1.5rem", width: "150px", textAlign: "center", borderRadius: "5px", border: "none" }}
                  />
                  <button 
                    onClick={() => joinRoom()} 
                    disabled={isConnecting}
                    style={{ padding: "10px 30px", background: isConnecting ? "#88dadfb0" : "#26c6da", border: "none", borderRadius: "20px", fontSize: "1.2rem", cursor: isConnecting ? "not-allowed" : "pointer" }}
                  >
                      {isConnecting ? "连接中..." : "进入"}
                  </button>
                  <button onClick={() => setLobbyStep("MULTI_LOBBY")} style={{ background: "transparent", border: "none", color: "#ccc", textDecoration: "underline" }}>返回</button>
                  
                  <div style={{ width: "100%", background: "rgba(0,0,0,0.8)", color: "#0f0", fontFamily: "monospace", fontSize: "10px", padding: "5px", borderRadius: "4px", height: "80px", overflowY: "auto", marginTop: "5px" }}>
                    {netLogs.length === 0 && <div style={{color: "#555"}}>网络日志...</div>}
                    {netLogs.map((log, i) => <div key={i}>{log}</div>)}
                  </div>
              </div>
          )}
          </>
          )}
        </div>
      </div>
    );
  }

  if (showReport) {
      return (
        <div className="full-screen-overlay" style={{ zIndex: 200 }}>
           <div style={{ background: "#2c3e50", borderRadius: "10px", padding: "20px", maxWidth: "90%", width: "700px", maxHeight: "80%", display: "flex", flexDirection: "column" }}>
               <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "15px", borderBottom: "1px solid #555", paddingBottom: "10px" }}>
                   <h2 style={{ margin: 0, color: "#fbc02d" }}>📊 战绩报表</h2>
                   <button onClick={() => setShowReport(false)} style={{ background: "none", border: "none", color: "white", fontSize: "24px", cursor: "pointer" }}>✕</button>
               </div>
               
               <div style={{ overflow: "auto", flex: 1, minHeight: "150px" }}>
                   <table style={{ width: "100%", borderCollapse: "collapse", color: "white", fontSize: "0.9rem" }}>
                       <thead>
                           <tr style={{ borderBottom: "1px solid #777" }}>
                               <th style={{ padding: "10px", textAlign: "left", background: "#34495e", position: "sticky", top: 0, left: 0, zIndex: 10, minWidth: "100px", borderRight: "2px solid #555" }}>玩家</th>
                               <th style={{ padding: "10px", textAlign: "right", background: "#34495e", position: "sticky", top: 0, zIndex: 5, color: "#fbc02d", borderRight: "1px solid #555" }}>累计</th>
                               {state.gameHistory.map((_, i) => (
                                   <th key={i} style={{ padding: "10px", textAlign: "right", minWidth: "60px", background: "#34495e", color: "white", border: "1px solid #555", position: "sticky", top: 0, zIndex: 5 }}>
                                       R{i+1}
                                   </th>
                               ))}
                           </tr>
                       </thead>
                       <tbody>
                           {state.players.map((p, pIdx) => {
                               const total = state.scores[p.id] || 0;
                               const totalColor = total > 0 ? "#fbc02d" : (total < 0 ? "#ff5252" : "#ffffff");
                               return (
                                   <tr key={p.id} style={{ borderBottom: "1px solid #444", background: pIdx % 2 === 0 ? "rgba(0,0,0,0.2)" : "transparent" }}>
                                       <td style={{ padding: "10px", position: "sticky", left: 0, background: pIdx % 2 === 0 ? "#263544" : "#2c3e50", zIndex: 2, borderRight: "2px solid #555", fontWeight: "bold", textAlign: "left" }}>
                                           {p.name}
                                       </td>
                                       <td style={{ padding: "10px", textAlign: "right", fontWeight: "900", color: totalColor, borderRight: "1px solid #555", fontSize: "1.1rem" }}>
                                           {total > 0 ? "+" : ""}{total}
                                       </td>
                                       {state.gameHistory.map((h, hIdx) => {
                                           const val = h[p.id] ?? 0;
                                           const color = val > 0 ? "#2ecc71" : (val < 0 ? "#ff5252" : "#ffffff");
                                           return (
                                               <td key={hIdx} style={{ padding: "10px", textAlign: "right", border: "1px solid #555", color: color, fontWeight: "bold" }}>
                                                   {val > 0 ? "+" : ""}{val}
                                               </td>
                                           );
                                       })}
                                   </tr>
                               );
                           })}
                       </tbody>
                   </table>
               </div>
               
               <div style={{ marginTop: "15px", display: "flex", justifyContent: "center", flexDirection: "column", alignItems: "center", gap: "5px" }}>
                   <button onClick={copyReportToClipboard} style={{ padding: "10px 20px", background: "#039be5", color: "white", border: "none", borderRadius: "5px", cursor: "pointer", fontWeight: "bold" }}>📋 复制战绩</button>
               </div>
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
               width: "90%", maxWidth: "500px", overflow: "hidden",
               border: "2px solid #f1c40f", display: "flex", flexDirection: "column", position: "relative"
           }}>
             <button
               onClick={exitToLobby}
               style={{
                 position: "absolute", top: "15px", right: "15px",
                 background: "rgba(0,0,0,0.2)", border: "none", color: "white",
                 width: "36px", height: "36px", borderRadius: "50%",
                 cursor: "pointer", fontSize: "20px", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 10
               }}
             >✕</button>

             <div style={{ background: "#a06000", padding: "20px", textAlign: "center", color: "white", borderBottom: "1px solid #c98e1a" }}>
                 <h2 style={{ margin: 0, fontSize: "2rem", fontWeight: "900" }}>本局分数结算</h2>
             </div>
             
             <div style={{ padding: "20px", background: "#2c3e50", flex: 1 }}>
               <div style={{ display: "grid", gridTemplateColumns: "1fr 2.5fr 50px 50px", gap: "10px", color: "#95a5a6", fontSize: "1rem", marginBottom: "15px", paddingBottom: "10px", borderBottom: "1px solid #34495e", fontWeight: "bold" }}>
                  <div style={{ textAlign: "left" }}>玩家</div>
                  <div style={{ textAlign: "right" }}>详情</div>
                  <div style={{ textAlign: "right" }}>变动</div>
                  <div style={{ textAlign: "right" }}>总分</div>
               </div>
               
               <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                 {state.players.map(p => {
                    const totalScore = state.scores[p.id] || 0;
                    const multiplier = Math.pow(2, state.bombCount);
                    let roundScore = 0;
                    const isWinner = p.id === state.lastWinnerIndex;
                    let detailText = "";

                    const lastHistory = state.gameHistory[state.gameHistory.length - 1] || {};
                    roundScore = lastHistory[p.id] || 0;

                    if (isWinner) {
                       detailText = "赢家通吃";
                    } else {
                       let base = p.cardsLeft;
                       let baseText = `剩${base}张`;
                       if (base === 1) { base = 0; baseText = `剩1张(免输)`; }
                       if (p.cardsLeft === 5 && !p.hasPlayed) { base = p.cardsLeft * 2; baseText = `全关x2`; }
                       detailText = baseText;
                       if (multiplier > 1 && p.cardsLeft !== 1) detailText += ` x${multiplier}倍`;
                    }

                    return (
                       <div key={p.id} style={{ display: "grid", gridTemplateColumns: "1fr 2.5fr 50px 50px", gap: "10px", alignItems: "center", background: isWinner ? "rgba(255, 193, 7, 0.2)" : "transparent", padding: "10px 10px", borderRadius: "8px", borderBottom: "1px solid #34495e" }}>
                         <div style={{ display: "flex", alignItems: "center", gap: "8px", textAlign: "left" }}>
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
             
             <div style={{ padding: "20px", textAlign: "center", background: "#2c3e50", display: "flex", flexDirection: "column", gap: "10px" }}>
                 <button 
                   onClick={() => state.isHost && startGame(state.players.length)}
                   disabled={!state.isHost}
                   style={{ padding: "15px 80px", fontSize: "1.3rem", cursor: state.isHost ? "pointer" : "not-allowed", background: state.isHost ? "#d4a017" : "#7f8c8d", border: "none", borderRadius: "10px", fontWeight: "bold", color: "white", boxShadow: "0 4px 0 rgba(0,0,0,0.2)" }}
                 >
                   {state.isHost ? "下一局" : "等待房主..."}
                 </button>
                 <button 
                   onClick={() => setShowReport(true)}
                   style={{ background: "transparent", border: "1px solid #7f8c8d", color: "#bdc3c7", padding: "10px", borderRadius: "8px", cursor: "pointer" }}
                 >
                   📊 查看战绩
                 </button>
             </div>
           </div>
        </div>
     );
  }

  const opponents = state.players.filter(p => p.id !== myId);
  const cardCount = user.hand.length;
  // Increase squeeze factor and base offset for tighter hand
  const squeeze = cardCount <= 5 ? -50 : -50 - ((cardCount - 5) * 5);
  const cardOverlap = Math.max(-80, squeeze);
  const isMyTurn = state.currentPlayerIndex === myId;

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", position: "relative", overflow: "hidden" }}>
      
      <div style={{ position: "absolute", top: "10px", left: "10px", zIndex: 50, color: "white", textShadow: "1px 1px 2px black", fontWeight: "bold", fontSize: "1.2rem", background: "rgba(0,0,0,0.3)", padding: "5px 12px", borderRadius: "15px" }}>
         第 {state.gameHistory.length + 1} 局
      </div>

      <div style={{ position: "absolute", top: "10px", right: "10px", zIndex: 50, display: "flex", gap: "10px" }}>
        <button onClick={toggleMute} style={{ background: "rgba(0,0,0,0.4)", color: "white", border: "2px solid white", borderRadius: "50%", width: "40px", height: "40px", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", fontSize: "16px" }}>{muted ? "🔇" : "🔊"}</button>
        <button onClick={exitToLobby} style={{ background: "rgba(0,0,0,0.4)", color: "white", border: "1px solid white", borderRadius: "20px", padding: "5px 15px", cursor: "pointer", height: "40px", fontWeight: "bold" }}>退出</button>
      </div>

      <div style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: "260px", pointerEvents: "none" }}>
        {opponents.map((opp) => {
          const posClass = getOpponentPositionStyle(opp.id, state.players.length);
          const avatar = BOT_AVATARS[(opp.id - 1) % BOT_AVATARS.length] || "👤";
          const isOppDealer = state.dealerId === opp.id;
          return (
            <div key={opp.id} className={`opponent-container ${posClass}`} style={{ opacity: state.currentPlayerIndex === opp.id ? 1 : 0.7, transform: state.currentPlayerIndex === opp.id ? "scale(1.15)" : "scale(1)", zIndex: 10 }}>
              <div style={{ position: "relative" }}>
                 <div style={{ width: "50px", height: "50px", borderRadius: "50%", background: opp.color, display: "flex", alignItems: "center", justifyContent: "center", border: state.currentPlayerIndex === opp.id ? "3px solid #fbc02d" : "2px solid #fff", color: "white", fontSize: "28px", boxShadow: "0 2px 4px rgba(0,0,0,0.3)" }}>{avatar}</div>
                 {isOppDealer && <div className="dealer-badge">庄</div>}
                 {opp.lastAction === "PASS" && <div className="pass-bubble">不要</div>}
              </div>
              <div style={{ background: "#fff", color: "#d32f2f", padding: "2px 8px", borderRadius: "10px", marginTop: "-10px", fontWeight: "bold", fontSize: "1.2rem", zIndex: 2, position: "relative", boxShadow: "0 1px 2px black" }}>{opp.cardsLeft}</div>
              <div style={{ fontSize: "0.8rem", marginTop: "4px", textShadow: "1px 1px 2px black", background: "rgba(0,0,0,0.5)", padding: "2px 4px", borderRadius: "4px" }}>{opp.name}</div>
            </div>
          );
        })}
      </div>

      <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", position: "relative" }}>
        <div style={{ display: "flex", marginLeft: "-49px", transform: "scale(1.2) translateY(73px)" }}>
          {state.tablePile.length === 0 ? (
             <div style={{ marginLeft: "49px", opacity: 0.3, border: "2px dashed #fff", width: "70px", height: "98px", borderRadius: "6px", display: "flex", alignItems: "center", justifyContent: "center" }}>空</div>
          ) : (
             state.tablePile[state.tablePile.length - 1].cards.map((c, i) => (
               <div key={c.id} className={getAnimClass(state.tablePile[state.tablePile.length - 1].playerId)} style={{ marginLeft: i === 0 ? "49px" : "-49px", zIndex: i }}>
                  <CardView 
                     card={c} 
                     small 
                   />
               </div>
             ))
          )}
        </div>
        
        <div style={{ position: "absolute", bottom: "-17px", background: "rgba(0,0,0,0.6)", padding: "8px 20px", borderRadius: "20px", border: "1px solid rgba(255,255,255,0.2)", zIndex: 40 }}>
           <span style={{ marginRight: "15px", color: "#e57373" }}>炸弹数: {state.bombCount}</span>
           <span style={{ color: "#fbc02d", fontWeight: "bold" }}>倍数: x{Math.pow(2, state.bombCount)}</span>
        </div>
        
        <div style={{ position: "absolute", bottom: "-58px", background: "rgba(255,255,255,0.9)", color: "#000", padding: "8px 16px", borderRadius: "4px", fontWeight: "bold", display: lastMessage ? "block" : "none", maxWidth: "90%", textAlign: "center", boxShadow: "0 2px 10px rgba(0,0,0,0.3)", zIndex: 40 }}>
          {lastMessage}
        </div>
      </div>

      <div style={{ height: "260px", display: "flex", flexDirection: "column", justifyContent: "flex-end", paddingBottom: "20px", background: "linear-gradient(to top, rgba(0,0,0,0.6), transparent)", zIndex: 20, position: "relative" }}>
         
         <div style={{ display: "flex", justifyContent: "center", alignItems: "center", gap: "20px", marginBottom: "25px", position: "relative", width: "100%" }}>
            {user.lastAction === "PASS" && !isMyTurn && (
                 <div className="pass-bubble" style={{ position: "absolute", top: "-40px", left: "50%", transform: "translateX(-50%)" }}>不要</div>
            )}

            {isMyTurn && state.status === 'playing' && (
              <>
                <button 
                  onClick={handleUserPass}
                  disabled={state.tablePile.length === 0 && state.lastWinnerIndex === myId}
                  style={{ padding: "10px 20px", background: "#e0e0e0", border: "none", borderRadius: "20px", fontWeight: "bold", fontSize: "1rem", cursor: "pointer", boxShadow: "0 2px 0 #9e9e9e" }}
                >
                  不要
                </button>
                <button 
                  onClick={handleUserPlay} 
                  disabled={selectedCardIds.length === 0}
                  style={{ padding: "10px 20px", background: "#fbc02d", border: "none", borderRadius: "20px", fontWeight: "bold", fontSize: "1rem", opacity: selectedCardIds.length === 0 ? 0.5 : 1, cursor: "pointer", boxShadow: "0 2px 0 #f57f17" }}
                >
                  出牌
                </button>
              </>
            )}

            {isDealer && (
                <div className="dealer-badge" style={{ 
                    position: "absolute", 
                    top: "50%", 
                    left: "20px", 
                    transform: "translateY(-50%)",
                    width: "40px", height: "40px", fontSize: "20px", 
                    border: "2px solid white", boxShadow: "0 2px 5px rgba(0,0,0,0.5)",
                    zIndex: 25
                }}>庄</div>
            )}

             <div style={{ 
                 position: "absolute", 
                 top: 0, bottom: 0, margin: "auto 0", height: "fit-content",
                 right: "10px", 
                 display: "flex", alignItems: "center", gap: "8px", 
                 background: "rgba(0,0,0,0.4)", padding: "5px 10px", borderRadius: "15px",
                 border: "1px solid rgba(255,255,255,0.3)", transform: "scale(0.85)", transformOrigin: "right center"
             }}>
                <div style={{ fontSize: "20px" }}>🂠</div>
                <span style={{ fontSize: "1rem", whiteSpace: "nowrap", fontWeight: "bold" }}>剩余 {state.deck.length}</span>
             </div>
         </div>

         <div style={{ display: "flex", justifyContent: "center", height: "130px", overflow: "visible" }}>
            <div style={{ display: "flex", marginLeft: "-50px" }}>
              {user.hand.map((card, i) => (
                <div key={card.id} style={{ marginLeft: i === 0 ? "50px" : `${cardOverlap}px`, zIndex: i }}>
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