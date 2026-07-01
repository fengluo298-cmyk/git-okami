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
    next.on("error:message", ({ message }: { message: string }) => Alert.alert("Notice", message));
    next.on("disconnect", (reason) => {
      setStatus(next.active ? "reconnecting" : "offline");
      setLastError(reason);
    });
    next.io.on("reconnect_attempt", () => setStatus("reconnecting"));
    next.on("connect_error", (error) => {
      setStatus("offline");
      setLastError(error.message);
    });
    setSocket(next);
  }

  function emit(event: string, payload: Record<string, unknown> = {}, onOk?: (result: Record<string, unknown>) => void) {
    if (!socket?.connected) {
      setLastError("Waiting for connection");
      return;
    }
    setBusy(true);
    socket.timeout(6000).emit(event, payload, (error: Error | null, result?: { ok: boolean; error?: string; [key: string]: unknown }) => {
      setBusy(false);
      if (error) return setLastError("Request timed out");
      if (!result?.ok) return showError(result?.error ?? "Action failed");
      onOk?.(result);
    });
  }

  async function joinVoice() {
    if (Platform.OS === "android") {
      const granted = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.RECORD_AUDIO);
      if (granted !== PermissionsAndroid.RESULTS.GRANTED) return showError("Microphone permission denied");
    }
    emit("voice:join", {}, (result) => setVoiceToken(String(result.voiceToken ?? "")));
  }

  function showError(error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    setLastError(message);
    Alert.alert("Notice", message);
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
    if (!json.ok) throw new Error(json.error ?? "Request failed");
    return json;
  }

  if (!user) {
    return (
      <SafeAreaView style={styles.screen}>
        <StatusBar barStyle="light-content" />
        <ScrollView contentContainerStyle={styles.connectPanel}>
          <Text style={styles.title}>Holdem Table</Text>
          <Text style={styles.caption}>Virtual chips only</Text>
          <Text style={styles.label}>API base</Text>
          <TextInput value={apiBase} onChangeText={setApiBase} autoCapitalize="none" autoCorrect={false} style={styles.input} />
          <Text style={styles.label}>Socket URL</Text>
          <TextInput value={socketUrl} onChangeText={setSocketUrl} autoCapitalize="none" autoCorrect={false} style={styles.input} />
          <Text style={styles.label}>Username</Text>
          <TextInput value={username} onChangeText={setUsername} autoCapitalize="none" autoCorrect={false} style={styles.input} />
          <Text style={styles.label}>Password</Text>
          <TextInput value={password} onChangeText={setPassword} secureTextEntry style={styles.input} />
          {authMode === "register" ? (
            <>
              <Text style={styles.label}>Nickname</Text>
              <TextInput value={nickname} onChangeText={setNickname} maxLength={16} style={styles.input} />
              <Text style={styles.label}>Avatar code or URL</Text>
              <TextInput value={avatar} onChangeText={setAvatar} maxLength={120} style={styles.input} />
            </>
          ) : null}
          <Pressable style={[styles.primaryButton, busy && styles.disabledButton]} disabled={busy} onPress={submitAuth}>
            <Text style={styles.primaryText}>{authMode === "login" ? "Log in" : "Create account"}</Text>
          </Pressable>
          <Pressable style={styles.textButton} onPress={() => setAuthMode(authMode === "login" ? "register" : "login")}>
            <Text style={styles.joinText}>{authMode === "login" ? "Need an account? Register" : "Have an account? Log in"}</Text>
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
          <Pressable style={styles.primaryButton} onPress={() => emit("rooms:create", { name: `${user.nickname}'s table` })}>
            <Text style={styles.primaryText}>Create table</Text>
          </Pressable>
          <Pressable style={styles.ghostButton} onPress={() => socket?.emit("rooms:list")}>
            <Text style={styles.ghostText}>Refresh</Text>
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
                  {item.status} / {item.seated}-{item.maxPlayers} / {item.smallBlind}-{item.bigBlind} / {item.bettingMode}
                </Text>
              </View>
              <Text style={styles.joinText}>Join</Text>
            </Pressable>
          )}
          ListEmptyComponent={<Text style={styles.empty}>No tables yet.</Text>}
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
            {room.status} / blinds {room.rules.smallBlind}-{room.rules.bigBlind} / buy-in {room.rules.minBuyIn}-{room.rules.maxBuyIn}
          </Text>
        </View>
        <Pressable style={[styles.ghostButton, room.status === "playing" && styles.disabledOutline]} disabled={room.status === "playing"} onPress={() => emit("rooms:leave")}>
          <Text style={styles.ghostText}>Leave</Text>
        </Pressable>
      </View>

      <ScrollView contentContainerStyle={styles.tableScroll}>
        <View style={styles.table}>
          <View style={styles.tableRail} />
          {room.seats.map((seat, index) => (
            <SeatView key={index} seat={seat} index={index} userId={user.id} game={room.game} disabled={busy || room.status === "playing"} onSit={() => emit("seat:sit", { seat: index, buyIn: Number(buyIn || room.rules.minBuyIn) })} />
          ))}
          <View style={styles.board}>
            <Text style={styles.street}>{room.game?.street ?? "lobby"}</Text>
            <View style={styles.cardsRow}>
              {Array.from({ length: 5 }).map((_, index) => (
                <CardView key={index} card={room.game?.board[index]} hidden={!room.game?.board[index]} small />
              ))}
            </View>
            <View style={styles.potPill}>
              <Text style={styles.potLabel}>POT</Text>
              <Text style={styles.pot}>{room.game?.pot ?? 0}</Text>
            </View>
          </View>
        </View>

        <View style={styles.myPanel}>
          <View style={styles.roomText}>
            <Text style={styles.panelTitle}>Your hand</Text>
            <Text style={styles.subtle}>{playerStateLabel(gameSeat, mySeat)}</Text>
          </View>
          <View style={styles.cardsRow}>{(gameSeat?.hand ?? []).map((card, index) => <CardView key={`${card.rank}${card.suit}${index}`} card={card} />)}</View>
        </View>

        {room.game?.winners?.length ? (
          <View style={styles.notice}>
            <Text style={styles.noticeText}>{room.game.winners.map((winner) => `${nameFor(room, winner.playerId)} +${winner.amount} (${winner.handName})`).join(" / ")}</Text>
          </View>
        ) : null}

        <View style={styles.controlPanel}>
          <VoicePanel room={room} myVoice={myVoice} voiceToken={voiceToken} onJoin={joinVoice} onLeave={() => emit("voice:leave", {}, () => setVoiceToken(""))} onMute={() => emit("voice:mute", { muted: !myVoice?.muted })} onSpeaking={() => emit("voice:speaking", { speaking: !myVoice?.speaking })} />

          {room.status !== "playing" ? (
            <>
              {mySeat ? (
                <View style={styles.row}>
                  <Pressable style={styles.ghostButton} onPress={() => emit("seat:leave")}>
                    <Text style={styles.ghostText}>Stand</Text>
                  </Pressable>
                  <Pressable style={mySeat.ready ? styles.warnButton : styles.primaryButton} onPress={() => emit("seat:ready", { ready: !mySeat.ready })}>
                    <Text style={styles.primaryText}>{mySeat.ready ? "Cancel ready" : "Ready"}</Text>
                  </Pressable>
                </View>
              ) : (
                <View style={styles.row}>
                  <TextInput value={buyIn} onChangeText={setBuyIn} keyboardType="number-pad" placeholder={`${room.rules.minBuyIn}-${room.rules.maxBuyIn}`} placeholderTextColor="#8d948f" style={[styles.input, styles.raiseInput]} />
                  <Text style={styles.empty}>Tap a seat</Text>
                </View>
              )}
              {room.ownerId === user.id ? (
                <Pressable style={styles.primaryButton} onPress={() => emit("game:start")}>
                  <Text style={styles.primaryText}>Start hand</Text>
                </Pressable>
              ) : null}
            </>
          ) : actions ? (
            <>
              <Text style={styles.actionHint}>{actions.canCheck ? "Your turn" : `Call ${actions.toCall} to stay in`}</Text>
              <View style={styles.row}>
                <Pressable style={styles.dangerButton} onPress={() => emit("game:action", { type: "fold" })}>
                  <Text style={styles.lightButtonText}>Fold</Text>
                </Pressable>
                <Pressable style={styles.primaryButton} onPress={() => emit("game:action", { type: actions.canCheck ? "check" : "call" })}>
                  <Text style={styles.primaryText}>{actions.canCheck ? "Check" : `Call ${actions.toCall}`}</Text>
                </Pressable>
                <Pressable style={styles.warnButton} onPress={() => emit("game:action", { type: "all-in" })}>
                  <Text style={styles.lightButtonText}>All-in</Text>
                </Pressable>
              </View>
              <View style={styles.row}>
                <TextInput value={raiseTo} onChangeText={setRaiseTo} keyboardType="number-pad" placeholder={`${actions.minRaiseTo}-${actions.maxRaiseTo}`} placeholderTextColor="#8d948f" style={[styles.input, styles.raiseInput]} />
                <Pressable style={styles.primaryButton} onPress={() => emit("game:action", { type: actions.canBet ? "bet" : "raise", amount: Number(raiseTo || actions.minRaiseTo) })}>
                  <Text style={styles.primaryText}>{actions.canBet ? "Bet" : "Raise"}</Text>
                </Pressable>
              </View>
            </>
          ) : (
            <Text style={styles.empty}>{status === "online" ? "Waiting for action." : "Reconnecting..."}</Text>
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
        <Text style={styles.brand}>Texas Hold'em</Text>
        <Text style={styles.subtle}>
          {user.nickname} / bank {user.chips}
        </Text>
      </View>
      <View style={styles.headerRight}>
        <View style={[styles.statusPill, status !== "online" && styles.statusWarn]}>
          <Text style={styles.statusText}>{status}</Text>
        </View>
        <Pressable style={styles.smallButton} onPress={onLogout}>
          <Text style={styles.ghostText}>Logout</Text>
        </Pressable>
      </View>
    </View>
  );
}

function VoicePanel({ room, myVoice, voiceToken, onJoin, onLeave, onMute, onSpeaking }: { room: RoomState; myVoice?: VoiceUser; voiceToken: string; onJoin: () => void; onLeave: () => void; onMute: () => void; onSpeaking: () => void }) {
  return (
    <View style={styles.voicePanel}>
      <Text style={styles.panelTitle}>Voice {myVoice ? (myVoice.muted ? "muted" : "connected") : "off"}</Text>
      <Text style={styles.subtle}>{room.voice.filter((voice) => voice.speaking).map((voice) => `${voice.nickname} speaking`).join(" / ") || "No one speaking"}</Text>
      <View style={styles.row}>
        <Pressable style={myVoice ? styles.warnButton : styles.primaryButton} onPress={myVoice ? onLeave : onJoin}>
          <Text style={myVoice ? styles.lightButtonText : styles.primaryText}>{myVoice ? "Voice off" : "Voice on"}</Text>
        </Pressable>
        {myVoice ? (
          <>
            <Pressable style={styles.ghostButton} onPress={onMute}>
              <Text style={styles.ghostText}>{myVoice.muted ? "Unmute" : "Mute"}</Text>
            </Pressable>
            <Pressable style={styles.ghostButton} onPress={onSpeaking}>
              <Text style={styles.ghostText}>{myVoice.speaking ? "Stop talking" : "Talking"}</Text>
            </Pressable>
          </>
        ) : null}
      </View>
      {voiceToken ? <Text style={styles.subtle}>Room voice token issued</Text> : null}
    </View>
  );
}

function SeatView({ seat, index, userId, game, disabled, onSit }: { seat: Seat | null; index: number; userId: string; game: RoomState["game"]; disabled: boolean; onSit: () => void }) {
  const liveSeat = game?.players.find((player) => player.seat === index) ?? seat;
  const role = game ? [game.dealerSeat === index ? "D" : "", game.smallBlindSeat === index ? "SB" : "", game.bigBlindSeat === index ? "BB" : ""].filter(Boolean).join(" ") : "";
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
              <Text style={styles.subtle}>{liveSeat.connected ? "online" : "offline"}</Text>
            </View>
          </View>
          <View style={styles.miniCards}>{Array.from({ length: liveSeat.cardCount ?? 0 }).map((_, cardIndex) => <CardView key={cardIndex} card={liveSeat.hand?.[cardIndex]} hidden={!liveSeat.hand?.[cardIndex] && liveSeat.id !== userId} small />)}</View>
          <Text style={styles.stack}>{liveSeat.chips} chips</Text>
          <Text style={styles.badge}>{seatBadge(liveSeat, role)}</Text>
        </>
      ) : (
        <Pressable disabled={disabled} style={styles.sitButton} onPress={onSit}>
          <Text style={styles.ghostText}>Sit</Text>
        </Pressable>
      )}
    </View>
  );
}

function playerStateLabel(gameSeat: Seat | null | undefined, mySeat: Seat | null): string {
  if (gameSeat?.folded) return "Folded";
  if (gameSeat?.allIn) return "All-in";
  if (gameSeat) return gameSeat.isTurn ? "Your turn" : "In hand";
  if (mySeat) return mySeat.ready ? "Ready" : "Seated";
  return "Watching";
}

function seatBadge(seat: Seat, role: string): string {
  if (seat.folded) return "Fold";
  if (seat.allIn) return "All-in";
  if (seat.bet) return `Bet ${seat.bet}`;
  return role || (seat.ready ? "Ready" : "Seat");
}

function nameFor(room: RoomState, userId: string): string {
  return room.seats.find((seat) => seat?.id === userId)?.nickname ?? "Player";
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
