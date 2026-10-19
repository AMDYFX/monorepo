import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { logger } from "./logger";
import { getToken, setToken as saveToken, clearToken } from "@/lib/auth";
import { clearAuthenticatedOfflineState } from "@/lib/offline-session";
import { secureStorage } from "@/lib/secure-storage";

interface User {
  id: string;
  email: string;
  name?: string;
  role?: string;
}

interface AuthState {
  token: string | null;
  user: User | null;
  isAuthenticated: boolean;
  setToken: (token: string | null) => Promise<void>;
  setUser: (user: User | null) => void;
  logout: () => Promise<void>;
  initializeAuth: () => Promise<void>;
}

const secureStorageAdapter = {
  getItem: async (name: string): Promise<string | null> => {
    if (typeof window === "undefined") return null;
    return await secureStorage.getItem(name);
  },
  setItem: async (name: string, value: string): Promise<void> => {
    if (typeof window === "undefined") return;
    await secureStorage.setItem(name, value);
  },
  removeItem: async (name: string): Promise<void> => {
    if (typeof window === "undefined") return;
    secureStorage.removeItem(name);
  },
};

const useAuthStore = create<AuthState>()(
  logger(
    persist(
      (set) => ({
        token: null,
        user: null,
        isAuthenticated: false,
        initializeAuth: async () => {
          const token = await getToken();
          set({ token, isAuthenticated: !!token });
        },
        setToken: async (token) => {
          if (token) {
            await saveToken(token);
          } else {
            clearToken();
          }
          set({ token, isAuthenticated: !!token });
        },
        setUser: (user) => set({ user }),
        logout: async () => {
          clearToken();
          await clearAuthenticatedOfflineState();
          set({ token: null, user: null, isAuthenticated: false });
        },
      }),
      {
        name: "shelterflex-auth-storage",
        storage: createJSONStorage(() => secureStorageAdapter as any),
        version: 1,
      }
    ),
    "AuthStore"
  )
);

export default useAuthStore;
