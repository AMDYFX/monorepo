"use client";

import { useEffect, useState } from "react";
import useRiskStore from "@/store/useRiskStore";

interface UseRiskStateResult {
  hasHydrated: boolean;
  isFrozen: boolean;
  freezeReason: string | null;
  deficitNgn: number;
  updatedAt: string | null;
  isLoading: boolean;
  refresh: () => Promise<void>;
}

export function useRiskState(): UseRiskStateResult {
  const [hasHydrated, setHasHydrated] = useState(false);
  const { 
    isFrozen, 
    freezeReason, 
    deficitNgn, 
    updatedAt, 
    isLoading, 
    fetchRiskState 
  } = useRiskStore();

  useEffect(() => {
    const unsubscribe = useRiskStore.persist.onFinishHydration(() => setHasHydrated(true));

    if (useRiskStore.persist.hasHydrated()) {
      setHasHydrated(true);
    } else {
      void useRiskStore.persist.rehydrate().catch(() => setHasHydrated(true));
    }

    return unsubscribe;
  }, []);

  useEffect(() => {
    if (hasHydrated) fetchRiskState();
  }, [fetchRiskState, hasHydrated]);

  return { 
    hasHydrated,
    isFrozen, 
    freezeReason, 
    deficitNgn, 
    updatedAt, 
    isLoading, 
    refresh: fetchRiskState 
  };
}
