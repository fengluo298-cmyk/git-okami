import AsyncStorage from "@react-native-async-storage/async-storage";
import * as SecureStore from "expo-secure-store";
import { clearStoredToken, readStoredToken, writeStoredToken } from "./tokenCore";

const stores = { legacy: AsyncStorage, secure: SecureStore };

export const tokenStorage = {
  get: () => readStoredToken(stores),
  set: (token: string) => writeStoredToken(stores, token),
  clear: () => clearStoredToken(stores)
};
