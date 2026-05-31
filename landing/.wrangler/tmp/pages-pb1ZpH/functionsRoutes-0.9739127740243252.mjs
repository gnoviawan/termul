import { onRequest as __api___path___ts_onRequest } from "D:\\Projects\\Vibe Code\\termul\\landing\\functions\\api\\[[path]].ts"

export const routes = [
    {
      routePath: "/api/:path*",
      mountPath: "/api",
      method: "",
      middlewares: [],
      modules: [__api___path___ts_onRequest],
    },
  ]