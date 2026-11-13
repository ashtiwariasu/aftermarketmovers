"use client";

import { useUser } from "@clerk/nextjs";
import { useEffect, useRef } from "react";
import {
  identifyAnalyticsUser,
  resetAnalyticsUser,
} from "@/lib/analytics";

/** Join anonymous acquisition activity to a stable Clerk ID after sign-in. */
export default function AnalyticsIdentity() {
  const { isLoaded, isSignedIn, user } = useUser();
  const identified = useRef<string | null>(null);

  useEffect(() => {
    if (!isLoaded) return;
    if (isSignedIn && user?.id) {
      if (identified.current !== user.id) {
        identifyAnalyticsUser(user.id);
        identified.current = user.id;
      }
      return;
    }
    if (identified.current) {
      resetAnalyticsUser();
      identified.current = null;
    }
  }, [isLoaded, isSignedIn, user?.id]);

  return null;
}

