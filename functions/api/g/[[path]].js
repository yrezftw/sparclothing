// /api/g/*  ->  garment gallery API (see lib/gallery-api.js)
import { handleGalleryApi } from "../../../lib/gallery-api.js";

export const onRequest = ({ request, env, params }) =>
  handleGalleryApi(request, env, [].concat(params.path ?? []));
