import { useQuery } from "@tanstack/react-query";
import { getBootstrapPayload } from "./client";

export function useDesktopBootstrap() {
  return useQuery({
    queryKey: ["desktop-bootstrap"],
    queryFn: getBootstrapPayload
  });
}

