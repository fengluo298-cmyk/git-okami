import { ActivityIndicator, StyleSheet, Text, View } from "react-native";

export function ProgressBar({ label }: { label: string }) {
  if (!label) return null;
  return (
    <View style={styles.box} accessibilityRole="progressbar" accessibilityLabel={label}>
      <ActivityIndicator color="#d6a844" />
      <View style={styles.track} />
      <Text style={styles.text}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  box: { marginHorizontal: 16, marginBottom: 10, padding: 10, borderRadius: 7, backgroundColor: "#161d1c", borderWidth: 1, borderColor: "#36443f", flexDirection: "row", alignItems: "center", gap: 10 },
  track: { flex: 1, height: 4, borderRadius: 2, overflow: "hidden", backgroundColor: "#2a3431" },
  text: { color: "#e8ddc8", fontSize: 12, fontWeight: "800" }
});
