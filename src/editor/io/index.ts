import type { IoModule } from '../contracts';
import { blobToPixelBuffer, decodeFile, makeThumbnail, pixelBufferToBlob } from './decode';
import { ACCEPT_ATTRIBUTE, isRawFileName, isSupportedFile, SUPPORTED_EXTENSIONS } from './formats';
import { readMetadata } from './metadata';
import { downscale, toLinearFloat, toSrgb8 } from './pixels';

export {
  ACCEPT_ATTRIBUTE,
  SUPPORTED_EXTENSIONS,
  blobToPixelBuffer,
  decodeFile,
  downscale,
  isRawFileName,
  isSupportedFile,
  makeThumbnail,
  pixelBufferToBlob,
  readMetadata,
  toLinearFloat,
  toSrgb8,
};

export const ioModule = {
  SUPPORTED_EXTENSIONS,
  ACCEPT_ATTRIBUTE,
  isSupportedFile,
  isRawFileName,
  decodeFile,
  readMetadata,
  makeThumbnail,
  downscale,
  toSrgb8,
  toLinearFloat,
  pixelBufferToBlob,
  blobToPixelBuffer,
} satisfies IoModule;
