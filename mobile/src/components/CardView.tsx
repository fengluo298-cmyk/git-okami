import { StyleSheet, Text, View } from "react-native";

export type Card = {
  rank: number;
  suit: "S" | "H" | "D" | "C";
};

const rankLabels: Record<number, string> = {
  2: "2",
  3: "3",
  4: "4",
  5: "5",
  6: "6",
  7: "7",
  8: "8",
  9: "9",
  10: "T",
  11: "J",
  12: "Q",
  13: "K",
  14: "A"
};
const suitLabels = { S: "♠", H: "♥", D: "♦", C: "♣" } as const;

export function CardView({ card, hidden = false, small = false }: { card?: Card; hidden?: boolean; small?: boolean }) {
  const red = card?.suit === "H" || card?.suit === "D";
  return (
    <View style={[styles.card, hidden && styles.hidden, small && styles.smallCard]}>
      <Text style={[styles.rank, red && styles.red, small && styles.smallText]}>{hidden || !card ? "?" : rankLabels[card.rank]}</Text>
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
