/**
 * Which image links a screen is allowed to load.
 *
 * The catalogue's photos do not live in this deployment. A shop keeps its pictures
 * where its pictures already are — for the reference installation, a Nextcloud folder
 * in the same homelab — and pastes the link into the product form, which is why
 * `products.image_url` is a link rather than a path (ADR 0014). So a screen is being
 * asked to fetch from an origin that is not this one, and that has to be a decision
 * rather than an accident: this function is the only place that decides.
 *
 * It is a **positive list**, not a sanitiser. A denylist of `javascript:` and `data:`
 * goes stale the first time a scheme nobody here has heard of turns up, whereas the
 * two forms a shop actually uses are both knowable:
 *
 *   * `https://…` and `http://…` — the shop's own host, or one it chooses.
 *   * a root-relative path, `/products/coffee.jpg` — something this deployment
 *     serves, which needs no scheme at all.
 *
 * Everything else renders as the placeholder instead, and the refusals are worth
 * naming because each one is a real mistake rather than a hypothetical:
 *
 *   * `data:` — an image inline in a column would make every catalogue page
 *     megabytes long, which is the opposite of the paging `product-query.ts` exists
 *     for.
 *   * `javascript:` and `file:` — never a picture.
 *   * a bare host, `example.com/x.jpg` — a browser resolves that *relative to the
 *     current page*, so it fetches a 404 from the wrong place and looks like a
 *     broken image rather than a bad link.
 *   * protocol-relative, `//host/x.jpg` — the browser would honour it, and it is
 *     refused anyway: it is the one form whose destination is not visible in the link
 *     an operator pasted, and no shop needs it.
 */
export function renderableImageUrl(value: string | null | undefined): string | null {
  const candidate = (value ?? '').trim();
  if (candidate === '') {
    return null;
  }

  if (candidate.startsWith('/')) {
    return candidate.startsWith('//') ? null : candidate;
  }

  try {
    const url = new URL(candidate);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null;
  } catch {
    return null;
  }
}

/** Why a link that looks like an image is not showing one, in the shop's words. */
export type ImageProbeFailure =
  | 'refused'
  | 'unreachable'
  | 'mixed-content'
  | 'no-server-check';

export interface ImageProbeResult {
  ok: boolean;
  /** Present only when `ok` is false; already a full Thai sentence. */
  message?: string;
  failure?: ImageProbeFailure;
}

const LOAD_TIMEOUT_MS = 8000;

/**
 * Actually tries to load a link, and says in Thai why it did not work.
 *
 * **Why this runs in the browser and not on the server.** The obvious implementation
 * is a `HEAD` request from the API, and it is the wrong one twice over. First,
 * security: this endpoint would then fetch whatever URL an admin typed, from inside
 * the shop's own network — which is a server-side request forgery primitive pointed at
 * every router, NAS and metadata service the deployment can reach. The usual
 * mitigation is to refuse private address ranges, and that mitigation is *also* wrong
 * here, because this shop's pictures are on a Nextcloud in the same homelab, on
 * `192.168.x.x`. The check that makes SSRF safe would break the one legitimate use.
 *
 * Second, and more simply: the browser is where the image has to load anyway. The
 * failure this is diagnosing — the tile showing a grey placeholder — is a *browser*
 * failure, and a server-side probe would happily report "200 OK" for a link the
 * browser then refuses to paint, because of a certificate, a hotlink rule, a login
 * redirect, or plain mixed content. Loading the URL with `new Image()` in the same
 * browser, under the same origin rules, reproduces the real failure exactly.
 *
 * A timeout rather than an open promise: a host that neither answers nor refuses
 * leaves the image object pending forever, and a save button that waits on it
 * forever is worse than one that reports what it can prove.
 */
export function probeImageUrl(
  value: string | null | undefined,
  options: { timeoutMs?: number } = {},
): Promise<ImageProbeResult> {
  const src = renderableImageUrl(value);
  if (src === null) {
    return Promise.resolve({
      ok: false,
      failure: 'refused',
      message:
        'ลิงก์นี้ใช้ไม่ได้ — ใส่ลิงก์รูปที่ขึ้นต้นด้วย https:// หรือ http:// เช่น https://cloud.example.com/coffee.jpg',
    });
  }

  // A page served over https may not load an http image. Saying so is the whole
  // point of this check, because the browser reports it as a generic load failure
  // and the operator has no way to tell a broken link from a blocked one.
  if (window.location.protocol === 'https:' && src.startsWith('http://')) {
    return Promise.resolve({
      ok: false,
      failure: 'mixed-content',
      message:
        'หน้าเว็บนี้เปิดด้วย https ซึ่งเบราว์เซอร์จะไม่ยอมโหลดรูปจากลิงก์ http — ใช้ลิงก์ https แทน หรือเปิดการแชร์ไฟล์เป็นลิงก์ https',
    });
  }

  return new Promise<ImageProbeResult>((resolve) => {
    const image = new Image();
    let settled = false;

    const finish = (result: ImageProbeResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      window.clearTimeout(timer);
      image.onload = null;
      image.onerror = null;
      resolve(result);
    };

    const timer = window.setTimeout(() => {
      finish({
        ok: false,
        failure: 'unreachable',
        message:
          'โหลดรูปไม่ทันภายใน 8 วินาที — เครื่องนี้ติดต่อเซิร์ฟเวอร์รูปไม่ได้ หรือลิงก์ชี้ไปที่ไฟล์ที่ใหญ่เกินไป',
      });
    }, options.timeoutMs ?? LOAD_TIMEOUT_MS);

    image.onload = () => {
      /*
       * A zero-dimension load is a real case rather than a paranoid one: a server can
       * answer 200 with an image the decoder cannot size, and the tile will render as
       * a blank box. The link "works" and does not show anything, which is the exact
       * confusion this whole function exists to remove.
       */
      if (image.naturalWidth === 0 || image.naturalHeight === 0) {
        finish({
          ok: false,
          failure: 'unreachable',
          message: 'เปิดลิงก์ได้แต่ไม่ใช่ไฟล์รูปที่แสดงผลได้ — ตรวจว่าเปิดลิงก์แล้วเห็นเป็นรูปจริง',
        });
        return;
      }
      finish({ ok: true });
    };

    image.onerror = () => {
      finish({
        ok: false,
        failure: 'unreachable',
        message:
          'เปิดรูปไม่ได้ — ลิงก์อาจผิด ลบแล้ว ต้องล็อกอินก่อนจึงจะเห็น หรือเป็นลิงก์หน้าเว็บที่ไม่ใช่ไฟล์รูปตรง ๆ',
      });
    };

    /*
     * `referrerPolicy` is set here too, not only on `Thumb`. Nextcloud and most home
     * NAS setups check it and refuse to serve to a hot-linked page; without this the
     * probe would report a link as broken that the till would then render fine.
     */
    image.referrerPolicy = 'no-referrer';
    image.src = src;
  });
}
