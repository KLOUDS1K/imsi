/**
 * Minimal typings for the `utif` package (plain CommonJS, ships no types).
 * Only the members the io module uses are declared.
 */
declare module 'utif' {
  /** A decoded IFD: tags are exposed as `t<tag>` arrays (e.g. `t256`). */
  export interface UtifIfd {
    [tag: `t${number}`]: number[] | string[] | undefined;
    width?: number;
    height?: number;
    data?: Uint8Array;
    isLE?: boolean;
    subIFD?: UtifIfd[];
    exifIFD?: UtifIfd;
  }
  interface UtifApi {
    decode(buf: ArrayBuffer): UtifIfd[];
    decodeImage(buf: ArrayBuffer, ifd: UtifIfd, ifds?: UtifIfd[]): void;
    toRGBA8(ifd: UtifIfd): Uint8Array;
    encodeImage(rgba: ArrayBuffer | Uint8Array, w: number, h: number, metadata?: Record<string, unknown>): ArrayBuffer;
  }
  const UTIF: UtifApi;
  export default UTIF;
}
