import AsyncStorage from "@react-native-async-storage/async-storage";
import { useEffect, useMemo, useState } from "react";
import {
  Alert,
  FlatList,
  PermissionsAndroid,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  View
} from "react-native";
import { io, type Socket } from "socket.io-client";
import { CardView, type Card } from "./src/components/CardView";

type User = { id: string; username: string | null; nickname: string; avatar: string; chips: number };
type Rules = {
  smallBlind: number;
  bigBlind: number;
  minBuyIn: number;
  maxBuyIn: number;
  maxPlayers: number;
  bettingMode: "no_limit" | "pot_limit" | "fixed_limit";
  minRaise: number;
  actionTimeoutSeconds: number;
  allowSpectators: boolean;
};
type RoomSummary = Rules & { id: string; name: string; status: string; seated: number };
type Seat = {
  id: string;
  nickname: string;
  avatar: string;
  chips: number;
  seat: number;
  ready: boolean;
  connected: boolean;
  bet?: number;
  folded?: boolean;
  allIn?: boolean;
  isTurn?: boolean;
  hand?: Card[];
  cardCount?: number;
};
type VoiceUser = { userId: string; nickname: string; muted: boolean; speaking: boolean };
type RoomState = {
  id: string;
  name: string;
  ownerId: string;
  status: "lobby" | "playing" | "finished";
  rules: Rules;
  seats: Array<Seat | null>;
  voice: VoiceUser[];
  game: null | {
    street: string;
    board: Card[];
    pot: number;
    dealerSeat: number;
    smallBlindSeat: number;
    bigBlindSeat: number;
    winners: Array<{ playerId: string; amount: number; handName: string }>;
    players: Seat[];
    availableActions: null | {
      toCall: number;
      minRaiseTo: number;
      maxRaiseTo: number;
      canCheck: boolean;
      canBet: boolean;
    };
  };
};
type ConnectionStatus = "idle" | "connecting" | "online" | "reconnecting" | "offline";

const tokenKey = "holdem.jwt";
const defaultSocketUrl = process.env.EXPO_PUBLIC_SOCKET_URL || process.env.EXPO_PUBLIC_SERVER_URL || "http://10.0.2.2:4000";
const defaultApiBase = process.env.EXPO_PUBLIC_API_BASE_URL || process.env.EXPO_PUBLIC_SERVER_URL || "http://10.0.2.2:4000";

export default function App() {
  const [apiBase, setApiBase] = useState(defaultApiBase);
  const [socketUrl, setSocketUrl] = useState(defaultSocketUrl);
  const [token, setToken] = useState("");
  const [authMode, setAuthMode] = useState<"login" | "register">("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [nickname, setNickname] = useState("");
  const [avatar, setAvatar] = useState("");
  const [socket, setSocket] = useState<Socket | null>(null);
  const [status, setStatus] = useState<ConnectionStatus>("idle");
  const [lastError, setLastError] = useState("");
  const [user, setUser] = useState<User | null>(null);
  const [rooms, setRooms] = useState<RoomSummary[]>([]);
  const [room, setRoom] = useState<RoomState | null>(null);
  const [busy, setBusy] = useState(false);
  const [raiseTo, setRaiseTo] = useState("");
  const [buyIn, setBuyIn] = useState("1000");
  const [voiceToken, setVoiceToken] = useState("");

  const mySeat = useMemo(() => room?.seats.find((seat) => seat?.id === user?.id) ?? null, [room, user]);
  const gameSeat = useMemo(() => room?.game?.players.find((seat) => seat.id === user?.id) ?? null, [room, user]);
  const actions = room?.game?.availableActions ?? null;
  const myVoice = room?.voice.find((voice) => voice.userId === user?.id);

  useEffect(() => {
    AsyncStorage.getItem(tokenKey).then((saved) => {
      if (saved) restoreSession(saved);
    });
  }, []);

  async function restoreSession(savedToken: string) {
    try {
      const result = await api("/auth/me", savedToken);
      await acceptAuth(savedToken, result.user as User);
    } catch {
      await AsyncStorage.removeItem(tokenKey);
    }
  }

  async function submitAuth() {
    setBusy(true);
    setLastError("");
    try {
      const path = authMode === "login" ? "/auth/login" : "/auth/register";
      const result = await api(path, undefined, { username, password, nickname, avatar });
      await acceptAuth(String(result.token), result.user as User);
    } catch (error) {
      showError(error);
    } finally {
      setBusy(false);
    }
  }

  async function acceptAuth(nextToken: string, nextUser: User) {
    setToken(nextToken);
    setUser(nextUser);
    await AsyncStorage.setItem(tokenKey, nextToken);
    connectSocket(nextToken);
  }

  async function logout() {
    socket?.disconnect();
    await AsyncStorage.removeItem(tokenKey);
    setToken("");
    setUser(null);
    setRoom(null);
    setRooms([]);
    setStatus("idle");
  }

  function connectSocket(nextToken = token) {
    socket?.disconnect();
    setStatus("connecting");
    const next = io(socketUrl.trim(), {
      transports: ["websocket"],
      auth: { token: nextToken },
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 500,
      reconnectionDelayMax: 3000,
      timeout: 8000
    });
    next.on("connect", () => {
      setStatus("online");
      setLastError("");
      next.emit("rooms:resume");
    });
    next.on("session", setUser);
    next.on("rooms:list", setRooms);
    next.on("room:state", setRoom);
    next.on("error:message", ({ message }: { message: string }) => Alert.alert("提示", zhMessage(message)));
    next.on("disconnect", (reason) => {
      setStatus(next.active ? "reconnecting" : "offline");
      setLastError(zhMessage(reason));
    });
    next.io.on("reconnect_attempt", () => setStatus("reconnecting"));
    next.on("connect_error", (error) => {
      setStatus("offline");
      setLastError(zhMessage(error.message));
    });
    setSocket(next);
  }

  function emit(event: string, payload: Record<string, unknown> = {}, onOk?: (result: Record<string, unknown>) => void) {
    if (!socket?.connected) {
      setLastError("正在等待连接");
      return;
    }
    setBusy(true);
    socket.timeout(6000).emit(event, payload, (error: Error | null, result?: { ok: boolean; error?: string; [key: string]: unknown }) => {
      setBusy(false);
      if (error) return setLastError("请求超时");
      if (!result?.ok) return showError(result?.error ?? "操作失败");
      onOk?.(result);
    });
  }

  async function joinVoice() {
    if (Platform.OS === "android") {
      const granted = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.RECORD_AUDIO);
      if (granted !== PermissionsAndroid.RESULTS.GRANTED) return showError("麦克风权限被拒绝");
    }
    emit("voice:join", {}, (result) => setVoiceToken(String(result.voiceToken ?? "")));
  }

  function showError(error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    setLastError(zhMessage(message));
    Alert.alert("提示", zhMessage(message));
  }

  async function api(path: string, authToken?: string, body?: Record<string, string>) {
    const res = await fetch(`${apiBase.trim()}${path}`, {
      method: body ? "POST" : "GET",
      headers: {
        "content-type": "application/json",
        ...(authToken ? { authorization: `Bearer ${authToken}` } : {})
      },
      body: body ? JSON.stringify(body) : undefined
    });
    const json = (await res.json()) as { ok: boolean; error?: string; [key: string]: unknown };
    if (!json.ok) throw new Error(json.error ?? "请求失败");
    return json;
  }

  if (!user) {
    return (
      <SafeAreaView style={styles.screen}>
        <StatusBar barStyle="light-content" />
        <ScrollView contentContainerStyle={styles.connectPanel}>
          <Text style={styles.title}>德州扑克</Text>
          <Text style={styles.caption}>仅使用虚拟筹码</Text>
          <Text style={styles.label}>接口地址</Text>
          <TextInput value={apiBase} onChangeText={setApiBase} autoCapitalize="none" autoCorrect={false} style={styles.input} />
          <Text style={styles.label}>联机地址</Text>
          <TextInput value={socketUrl} onChangeText={setSocketUrl} autoCapitalize="none" autoCorrect={false} style={styles.input} />
          <Text style={styles.label}>用户名</Text>
          <TextInput value={username} onChangeText={setUsername} autoCapitalize="none" autoCorrect={false} style={styles.input} />
          <Text style={styles.label}>密码</Text>
          <TextInput value={password} onChangeText={setPassword} secureTextEntry style={styles.input} />
          {authMode === "register" ? (
            <>
              <Text style={styles.label}>昵称</Text>
              <TextInput value={nickname} onChangeText={setNickname} maxLength={16} style={styles.input} />
              <Text style={styles.label}>头像代码或链接</Text>
              <TextInput value={avatar} onChangeText={setAvatar} maxLength={120} style={styles.input} />
            </>
          ) : null}
          <Pressable style={[styles.primaryButton, busy && styles.disabledButton]} disabled={busy} onPress={submitAuth}>
            <Text style={styles.primaryText}>{authMode === "login" ? "登录" : "创建账号"}</Text>
          </Pressable>
          <Pressable style={styles.textButton} onPress={() => setAuthMode(authMode === "login" ? "register" : "login")}>
            <Text style={styles.joinText}>{authMode === "login" ? "没有账号？去注册" : "已有账号？去登录"}</Text>
          </Pressable>
          {lastError ? <Text style={styles.errorText}>{lastError}</Text> : null}
        </ScrollView>
      </SafeAreaView>
    );
  }

  if (!room) {
    return (
      <SafeAreaView style={styles.screen}>
        <Header user={user} status={status} onLogout={logout} />
        <View style={styles.lobbyActions}>
          <Pressable style={styles.primaryButton} onPress={() => emit("rooms:create", { name: `${user.nickname}的牌桌` })}>
            <Text style={styles.primaryText}>创建牌桌</Text>
          </Pressable>
          <Pressable style={styles.ghostButton} onPress={() => socket?.emit("rooms:list")}>
            <Text style={styles.ghostText}>刷新</Text>
          </Pressable>
        </View>
        <FlatList
          data={rooms}
          keyExtractor={(item) => item.id}
          contentContainerStyle={styles.roomList}
          renderItem={({ item }) => (
            <Pressable style={styles.roomRow} onPress={() => emit("rooms:join", { roomId: item.id })}>
              <View style={styles.roomText}>
                <Text style={styles.roomName} numberOfLines={1}>
                  {item.name}
                </Text>
                <Text style={styles.subtle}>
                  {roomStatusLabel(item.status)} / {item.seated}-{item.maxPlayers}人 / 盲注 {item.smallBlind}-{item.bigBlind} / {bettingModeLabel(item.bettingMode)}
                </Text>
              </View>
              <Text style={styles.joinText}>加入</Text>
            </Pressable>
          )}
          ListEmptyComponent={<Text style={styles.empty}>暂无牌桌</Text>}
        />
        {lastError ? <Text style={styles.footerError}>{lastError}</Text> : null}
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.screen}>
      <Header user={user} status={status} onLogout={logout} />
      <View style={styles.roomHeader}>
        <View style={styles.roomText}>
          <Text style={styles.roomName} numberOfLines={1}>
            {room.name}
          </Text>
          <Text style={styles.subtle}>
            {roomStatusLabel(room.status)} / 盲注 {room.rules.smallBlind}-{room.rules.bigBlind} / 买入 {room.rules.minBuyIn}-{room.rules.maxBuyIn}
          </Text>
        </View>
        <Pressable style={[styles.ghostButton, room.status === "playing" && styles.disabledOutline]} disabled={room.status === "playing"} onPress={() => emit("rooms:leave")}>
          <Text style={styles.ghostText}>离开</Text>
        </Pressable>
      </View>

      <ScrollView contentContainerStyle={styles.tableScroll}>
        <View style={styles.table}>
          <View style={styles.tableRail} />
          {room.seats.map((seat, index) => (
            <SeatView key={index} seat={seat} index={index} userId={user.id} game={room.game} disabled={busy || room.status === "playing"} onSit={() => emit("seat:sit", { seat: index, buyIn: Number(buyIn || room.rules.minBuyIn) })} />
          ))}
          <View style={styles.board}>
            <Text style={styles.street}>{streetLabel(room.game?.street ?? "lobby")}</Text>
            <View style={styles.cardsRow}>
              {Array.from({ length: 5 }).map((_, index) => (
                <CardView key={index} card={room.game?.board[index]} hidden={!room.game?.board[index]} small />
              ))}
            </View>
            <View style={styles.potPill}>
              <Text style={styles.potLabel}>底池</Text>
              <Text style={styles.pot}>{room.game?.pot ?? 0}</Text>
            </View>
          </View>
        </View>

        <View style={styles.myPanel}>
          <View style={styles.roomText}>
            <Text style={styles.panelTitle}>我的手牌</Text>
            <Text style={styles.subtle}>{playerStateLabel(gameSeat, mySeat)}</Text>
          </View>
          <View style={styles.cardsRow}>{(gameSeat?.hand ?? []).map((card, index) => <CardView key={`${card.rank}${card.suit}${index}`} card={card} />)}</View>
        </View>

        {room.game?.winners?.length ? (
          <View style={styles.notice}>
            <Text style={styles.noticeText}>{room.game.winners.map((winner) => `${nameFor(room, winner.playerId)} +${winner.amount}（${handNameLabel(winner.handName)}）`).join(" / ")}</Text>
          </View>
        ) : null}

        <View style={styles.controlPanel}>
          <VoicePanel room={room} myVoice={myVoice} voiceToken={voiceToken} onJoin={joinVoice} onLeave={() => emit("voice:leave", {}, () => setVoiceToken(""))} onMute={() => emit("voice:mute", { muted: !myVoice?.muted })} onSpeaking={() => emit("voice:speaking", { speaking: !myVoice?.speaking })} />

          {room.status !== "playing" ? (
            <>
              {mySeat ? (
                <View style={styles.row}>
                  <Pressable style={styles.ghostButton} onPress={() => emit("seat:leave")}>
                    <Text style={styles.ghostText}>起身</Text>
                  </Pressable>
                  <Pressable style={mySeat.ready ? styles.warnButton : styles.primaryButton} onPress={() => emit("seat:ready", { ready: !mySeat.ready })}>
                    <Text style={styles.primaryText}>{mySeat.ready ? "取消准备" : "准备"}</Text>
                  </Pressable>
                </View>
              ) : (
                <View style={styles.row}>
                  <TextInput value={buyIn} onChangeText={setBuyIn} keyboardType="number-pad" placeholder={`${room.rules.minBuyIn}-${room.rules.maxBuyIn}`} placeholderTextColor="#8d948f" style={[styles.input, styles.raiseInput]} />
                  <Text style={styles.empty}>点击座位坐下</Text>
                </View>
              )}
              {room.ownerId === user.id ? (
                <Pressable style={styles.primaryButton} onPress={() => emit("game:start")}>
                  <Text style={styles.primaryText}>开始一局</Text>
                </Pressable>
              ) : null}
            </>
          ) : actions ? (
            <>
              <Text style={styles.actionHint}>{actions.canCheck ? "轮到你行动" : `跟注 ${actions.toCall} 继续`}</Text>
              <View style={styles.row}>
                <Pressable style={styles.dangerButton} onPress={() => emit("game:action", { type: "fold" })}>
                  <Text style={styles.lightButtonText}>弃牌</Text>
                </Pressable>
                <Pressable style={styles.primaryButton} onPress={() => emit("game:action", { type: actions.canCheck ? "check" : "call" })}>
                  <Text style={styles.primaryText}>{actions.canCheck ? "过牌" : `跟注 ${actions.toCall}`}</Text>
                </Pressable>
                <Pressable style={styles.warnButton} onPress={() => emit("game:action", { type: "all-in" })}>
                  <Text style={styles.lightButtonText}>全下</Text>
                </Pressable>
              </View>
              <View style={styles.row}>
                <TextInput value={raiseTo} onChangeText={setRaiseTo} keyboardType="number-pad" placeholder={`${actions.minRaiseTo}-${actions.maxRaiseTo}`} placeholderTextColor="#8d948f" style={[styles.input, styles.raiseInput]} />
                <Pressable style={styles.primaryButton} onPress={() => emit("game:action", { type: actions.canBet ? "bet" : "raise", amount: Number(raiseTo || actions.minRaiseTo) })}>
                  <Text style={styles.primaryText}>{actions.canBet ? "下注" : "加注"}</Text>
                </Pressable>
              </View>
            </>
          ) : (
            <Text style={styles.empty}>{status === "online" ? "等待其他玩家行动" : "正在重连..."}</Text>
          )}
          {lastError ? <Text style={styles.footerError}>{lastError}</Text> : null}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

function Header({ user, status, onLogout }: { user: User; status: ConnectionStatus; onLogout: () => void }) {
  return (
    <View style={styles.header}>
      <View>
        <Text style={styles.brand}>德州扑克</Text>
        <Text style={styles.subtle}>
          {user.nickname} / 余额 {user.chips}
        </Text>
      </View>
      <View style={styles.headerRight}>
        <View style={[styles.statusPill, status !== "online" && styles.statusWarn]}>
          <Text style={styles.statusText}>{connectionLabel(status)}</Text>
        </View>
        <Pressable style={styles.smallButton} onPress={onLogout}>
          <Text style={styles.ghostText}>退出</Text>
        </Pressable>
      </View>
    </View>
  );
}

function VoicePanel({ room, myVoice, voiceToken, onJoin, onLeave, onMute, onSpeaking }: { room: RoomState; myVoice?: VoiceUser; voiceToken: string; onJoin: () => void; onLeave: () => void; onMute: () => void; onSpeaking: () => void }) {
  return (
    <View style={styles.voicePanel}>
      <Text style={styles.panelTitle}>语音{myVoice ? (myVoice.muted ? "已静音" : "已连接") : "已关闭"}</Text>
      <Text style={styles.subtle}>{room.voice.filter((voice) => voice.speaking).map((voice) => `${voice.nickname} 正在说话`).join(" / ") || "暂无说话玩家"}</Text>
      <View style={styles.row}>
        <Pressable style={myVoice ? styles.warnButton : styles.primaryButton} onPress={myVoice ? onLeave : onJoin}>
          <Text style={myVoice ? styles.lightButtonText : styles.primaryText}>{myVoice ? "关闭语音" : "打开语音"}</Text>
        </Pressable>
        {myVoice ? (
          <>
            <Pressable style={styles.ghostButton} onPress={onMute}>
              <Text style={styles.ghostText}>{myVoice.muted ? "取消静音" : "静音"}</Text>
            </Pressable>
            <Pressable style={styles.ghostButton} onPress={onSpeaking}>
              <Text style={styles.ghostText}>{myVoice.speaking ? "停止说话" : "说话中"}</Text>
            </Pressable>
          </>
        ) : null}
      </View>
      {voiceToken ? <Text style={styles.subtle}>已获取房间语音令牌</Text> : null}
    </View>
  );
}

function SeatView({ seat, index, userId, game, disabled, onSit }: { seat: Seat | null; index: number; userId: string; game: RoomState["game"]; disabled: boolean; onSit: () => void }) {
  const liveSeat = game?.players.find((player) => player.seat === index) ?? seat;
  const role = game ? [game.dealerSeat === index ? "庄" : "", game.smallBlindSeat === index ? "小盲" : "", game.bigBlindSeat === index ? "大盲" : ""].filter(Boolean).join(" ") : "";
  return (
    <View style={[styles.seat, seatPositions[index], liveSeat?.isTurn && styles.turnSeat]}>
      {liveSeat ? (
        <>
          <View style={styles.seatTop}>
            <Text style={[styles.avatar, !liveSeat.connected && styles.avatarOffline]}>{liveSeat.avatar}</Text>
            <View style={styles.seatText}>
              <Text style={styles.seatName} numberOfLines={1}>
                {liveSeat.nickname}
              </Text>
              <Text style={styles.subtle}>{liveSeat.connected ? "在线" : "离线"}</Text>
            </View>
          </View>
          <View style={styles.miniCards}>{Array.from({ length: liveSeat.cardCount ?? 0 }).map((_, cardIndex) => <CardView key={cardIndex} card={liveSeat.hand?.[cardIndex]} hidden={!liveSeat.hand?.[cardIndex] && liveSeat.id !== userId} small />)}</View>
          <Text style={styles.stack}>{liveSeat.chips} 筹码</Text>
          <Text style={styles.badge}>{seatBadge(liveSeat, role)}</Text>
        </>
      ) : (
        <Pressable disabled={disabled} style={styles.sitButton} onPress={onSit}>
          <Text style={styles.ghostText}>坐下</Text>
        </Pressable>
      )}
    </View>
  );
}

function playerStateLabel(gameSeat: Seat | null | undefined, mySeat: Seat | null): string {
  if (gameSeat?.folded) return "已弃牌";
  if (gameSeat?.allIn) return "已全下";
  if (gameSeat) return gameSeat.isTurn ? "轮到你行动" : "牌局中";
  if (mySeat) return mySeat.ready ? "已准备" : "已坐下";
  return "观战中";
}

function seatBadge(seat: Seat, role: string): string {
  if (seat.folded) return "弃牌";
  if (seat.allIn) return "全下";
  if (seat.bet) return `下注 ${seat.bet}`;
  return role || (seat.ready ? "准备" : "座位");
}

function nameFor(room: RoomState, userId: string): string {
  return room.seats.find((seat) => seat?.id === userId)?.nickname ?? "玩家";
}

function connectionLabel(status: ConnectionStatus): string {
  return { idle: "未连接", connecting: "连接中", online: "在线", reconnecting: "重连中", offline: "离线" }[status];
}

function roomStatusLabel(status: string): string {
  return { lobby: "大厅", playing: "游戏中", finished: "已结束" }[status] ?? status;
}

function bettingModeLabel(mode: Rules["bettingMode"]): string {
  return { no_limit: "无限注", pot_limit: "底池限注", fixed_limit: "固定限注" }[mode];
}

function streetLabel(street: string): string {
  return { lobby: "大厅", waiting: "等待中", preflop: "翻牌前", flop: "翻牌", turn: "转牌", river: "河牌", showdown: "摊牌", finished: "已结束" }[street] ?? street;
}

function handNameLabel(name: string): string {
  return {
    "High card": "高牌",
    "One pair": "一对",
    "Two pair": "两对",
    "Three of a kind": "三条",
    Straight: "顺子",
    Flush: "同花",
    "Full house": "葫芦",
    "Four of a kind": "四条",
    "Straight flush": "同花顺",
    "Royal flush": "皇家同花顺",
    Uncontested: "未摊牌获胜"
  }[name] ?? name;
}

function zhMessage(message: string): string {
  if (message.startsWith("Seat must be ")) return message.replace("Seat must be ", "座位必须是 ");
  if (message.startsWith("Buy-in must be ")) return message.replace("Buy-in must be ", "买入必须是 ");
  if (message.startsWith("Bet cannot exceed ")) return message.replace("Bet cannot exceed ", "下注不能超过 ");
  if (message.startsWith("Fixed-limit bet must be ")) return message.replace("Fixed-limit bet must be ", "固定限注下注必须是 ");
  if (message.startsWith("Seat ") && message.endsWith(" is empty")) return "该座位为空";
  return (
    {
      "Username is required": "请输入用户名",
      "Username already exists": "用户名已存在",
      "User not found": "用户不存在",
      "Password must be at least 6 characters": "密码至少需要 6 个字符",
      "Invalid username or password": "用户名或密码错误",
      "Invalid token": "登录已失效，请重新登录",
      "Missing token": "请先登录",
      "Token expired": "登录已过期，请重新登录",
      "Waiting for connection": "正在等待连接",
      "Request timed out": "请求超时",
      "Action failed": "操作失败",
      "Request failed": "请求失败",
      "Microphone permission denied": "麦克风权限被拒绝",
      "Cannot leave during a hand": "牌局进行中不能离开房间",
      "Cannot change seats during a hand": "牌局进行中不能换座",
      "Seat is taken": "该座位已有人",
      "Cannot leave seat during a hand": "牌局进行中不能起身",
      "Hand is already running": "牌局已经开始",
      "Sit down first": "请先坐下",
      "Only the owner can start": "只有房主可以开始",
      "Need at least two ready players": "至少需要两名已准备玩家",
      "No active hand": "当前没有进行中的牌局",
      "Join the room first": "请先加入房间",
      "Join voice first": "请先加入语音",
      "Join a room first": "请先加入房间",
      "Room not found": "房间不存在",
      "At least five cards are required": "至少需要五张牌",
      "At least two players are required": "至少需要两名玩家",
      "Player is not in this hand": "该玩家不在本局中",
      "It is not this player's turn": "还没轮到该玩家行动",
      "Folded players cannot act": "已弃牌玩家不能行动",
      "All-in players cannot act": "已全下玩家不能行动",
      "Cannot check while facing a bet": "面对下注时不能过牌",
      "Nothing to call": "当前无需跟注",
      "Bet must add chips": "下注必须增加筹码",
      "Not enough chips": "筹码不足",
      "Use raise while facing a bet": "面对下注时请使用加注",
      "Use bet to open action": "无人下注时请使用下注",
      "Bet must beat the current bet": "下注必须高于当前下注",
      "Raise is below the minimum": "加注低于最小额度",
      "Opening bet is below the minimum": "开局下注低于最小额度",
      "Deck is empty": "牌堆已空",
      "No next occupied seat": "没有下一个有人的座位",
      "Unauthorized": "登录已失效，请重新登录",
      "Not found": "未找到",
      "transport close": "连接已断开",
      "websocket error": "联机连接失败",
      "xhr poll error": "联机连接失败"
    }[message] ?? message
  );
}

const seatPositions = [
  { left: "35%", top: 10 },
  { right: 8, top: 76 },
  { right: 8, bottom: 62 },
  { left: "35%", bottom: 10 },
  { left: 8, bottom: 62 },
  { left: 8, top: 76 }
] as const;

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "#0f1211" },
  connectPanel: { flexGrow: 1, padding: 24, justifyContent: "center" },
  title: { color: "#f4ead5", fontSize: 36, fontWeight: "900", marginBottom: 6 },
  caption: { color: "#d6a844", fontSize: 13, fontWeight: "800", marginBottom: 28, textTransform: "uppercase" },
  header: { paddingHorizontal: 18, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: "#29322f", backgroundColor: "#151918", flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  headerRight: { flexDirection: "row", alignItems: "center", gap: 8 },
  brand: { color: "#f4ead5", fontSize: 18, fontWeight: "900" },
  statusPill: { minWidth: 78, minHeight: 28, borderRadius: 7, paddingHorizontal: 10, alignItems: "center", justifyContent: "center", backgroundColor: "#1d4f3d", borderWidth: 1, borderColor: "#3aa36d" },
  statusWarn: { backgroundColor: "#49351d", borderColor: "#d6a844" },
  statusText: { color: "#f7f1e6", fontSize: 11, fontWeight: "900", textTransform: "uppercase" },
  label: { color: "#c6d0c7", marginBottom: 8, fontWeight: "700" },
  input: { backgroundColor: "#1b2221", borderWidth: 1, borderColor: "#3a4846", color: "#f8f2e7", borderRadius: 7, minHeight: 46, paddingHorizontal: 12, marginBottom: 14 },
  lobbyActions: { flexDirection: "row", gap: 10, padding: 16 },
  primaryButton: { backgroundColor: "#d6a844", borderRadius: 7, minHeight: 44, paddingHorizontal: 16, alignItems: "center", justifyContent: "center" },
  warnButton: { backgroundColor: "#a85438", borderRadius: 7, minHeight: 44, paddingHorizontal: 16, alignItems: "center", justifyContent: "center" },
  dangerButton: { backgroundColor: "#6f2733", borderRadius: 7, minHeight: 44, paddingHorizontal: 16, alignItems: "center", justifyContent: "center" },
  ghostButton: { borderWidth: 1, borderColor: "#66726e", borderRadius: 7, minHeight: 44, paddingHorizontal: 14, alignItems: "center", justifyContent: "center" },
  smallButton: { borderWidth: 1, borderColor: "#66726e", borderRadius: 7, minHeight: 28, paddingHorizontal: 8, alignItems: "center", justifyContent: "center" },
  textButton: { minHeight: 44, alignItems: "center", justifyContent: "center" },
  disabledButton: { opacity: 0.6 },
  disabledOutline: { opacity: 0.35 },
  primaryText: { color: "#19140d", fontWeight: "900" },
  lightButtonText: { color: "#fff8eb", fontWeight: "900" },
  ghostText: { color: "#e5dccb", fontWeight: "800" },
  roomList: { padding: 16, gap: 10 },
  roomRow: { backgroundColor: "#171e1d", borderWidth: 1, borderColor: "#2b3a36", borderRadius: 8, padding: 14, flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  roomText: { flex: 1, minWidth: 0 },
  roomName: { color: "#f4ead5", fontSize: 17, fontWeight: "900" },
  joinText: { color: "#d6a844", fontWeight: "900" },
  subtle: { color: "#9ea9a3", fontSize: 12 },
  empty: { color: "#bbc4bd", textAlign: "center", padding: 18 },
  errorText: { color: "#f0a49b", marginTop: 12, textAlign: "center" },
  footerError: { color: "#f0a49b", fontSize: 12, textAlign: "center", paddingHorizontal: 12 },
  roomHeader: { paddingHorizontal: 16, paddingVertical: 10, flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 10 },
  tableScroll: { paddingBottom: 24 },
  table: { height: 494, marginHorizontal: 10, borderRadius: 190, backgroundColor: "#15523f", borderWidth: 10, borderColor: "#32261d", position: "relative", overflow: "hidden" },
  tableRail: { position: "absolute", left: 18, right: 18, top: 18, bottom: 18, borderRadius: 170, borderWidth: 1, borderColor: "rgba(214, 168, 68, 0.35)" },
  board: { position: "absolute", left: "22%", right: "22%", top: "37%", alignItems: "center", gap: 7 },
  street: { color: "#dcefe4", textTransform: "uppercase", fontWeight: "900" },
  cardsRow: { flexDirection: "row", alignItems: "center", justifyContent: "center" },
  potPill: { minWidth: 92, borderRadius: 7, paddingVertical: 5, paddingHorizontal: 10, alignItems: "center", backgroundColor: "rgba(15, 18, 17, 0.72)", borderWidth: 1, borderColor: "rgba(214, 168, 68, 0.45)" },
  potLabel: { color: "#9ea9a3", fontSize: 10, fontWeight: "900" },
  pot: { color: "#f0c767", fontSize: 18, fontWeight: "900" },
  seat: { position: "absolute", width: 108, minHeight: 116, borderRadius: 8, padding: 7, backgroundColor: "rgba(17, 22, 23, 0.9)", borderWidth: 1, borderColor: "#3a4641" },
  turnSeat: { borderColor: "#f0c767", borderWidth: 2 },
  seatTop: { flexDirection: "row", alignItems: "center", gap: 6 },
  avatar: { width: 28, height: 28, borderRadius: 14, textAlign: "center", textAlignVertical: "center", backgroundColor: "#d6a844", color: "#19140d", fontWeight: "900", fontSize: 11 },
  avatarOffline: { backgroundColor: "#59615e", color: "#d6ded8" },
  seatText: { flex: 1, minWidth: 0 },
  seatName: { color: "#f4ead5", fontWeight: "900" },
  miniCards: { minHeight: 42, marginTop: 5, flexDirection: "row" },
  stack: { color: "#dcefe4", fontWeight: "800", fontSize: 12 },
  badge: { color: "#f0c767", fontWeight: "900", fontSize: 11 },
  sitButton: { flex: 1, alignItems: "center", justifyContent: "center" },
  myPanel: { margin: 12, padding: 12, borderRadius: 8, backgroundColor: "#181f20", borderWidth: 1, borderColor: "#30413d", flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 10 },
  panelTitle: { color: "#f4ead5", fontWeight: "900", fontSize: 16 },
  notice: { marginHorizontal: 12, marginBottom: 10, padding: 10, borderRadius: 7, backgroundColor: "#253526" },
  noticeText: { color: "#dcefe4", textAlign: "center", fontWeight: "800" },
  controlPanel: { marginHorizontal: 12, padding: 12, borderRadius: 8, backgroundColor: "#151a1c", borderWidth: 1, borderColor: "#2a3734", gap: 10 },
  voicePanel: { padding: 10, borderRadius: 7, backgroundColor: "#101615", borderWidth: 1, borderColor: "#2a3734", gap: 8 },
  actionHint: { color: "#f4ead5", fontWeight: "900", textAlign: "center" },
  row: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8 },
  raiseInput: { flex: 1, marginBottom: 0 }
});
