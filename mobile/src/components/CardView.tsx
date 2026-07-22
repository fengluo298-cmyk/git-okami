import { StyleSheet, Text, View } from "react-native";
import { displayCardRank, type Card } from "../utils/cards";

const suitLabels = { S: "♠", H: "♥", D: "♦", C: "♣" } as const;

export function CardView({ card, hidden = false, small = false }: { card?: Card; hidden?: boolean; small?: boolean }) {
  const red = card?.suit === "H" || card?.suit === "D";
  return (
    <View style={[styles.card, hidden && styles.hidden, small && styles.smallCard]}>
      <Text style={[styles.rank, red && styles.red, small && styles.smallText]}>{displayCardRank(card, hidden)}</Text>
      <Text style={[styles.suit, red && styles.red, small && styles.smallText]}>{hidden || !card ? "" : suitLabels[card.suit]}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    width: 48,
    height: 66,
    borderRadius: 7,
    backgroundColor: "#f6f1e8",
    borderWidth: 1,
    borderColor: "#dacfbf",
    alignItems: "center",
    justifyContent: "center",
    marginHorizontal: 3
  },
  hidden: {
    backgroundColor: "#284f7a",
    borderColor: "#8bb7e8"
  },
  smallCard: {
    width: 30,
    height: 42,
    borderRadius: 5,
    marginHorizontal: 1
  },
  rank: {
    color: "#171717",
    fontSize: 20,
    fontWeight: "800"
  },
  suit: {
    color: "#171717",
    fontSize: 13,
    fontWeight: "700"
  },
  red: {
    color: "#c83f43"
  },
  smallText: {
    fontSize: 12
  }
});
