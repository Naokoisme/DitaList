// Desktop storage has one writer: the Rust core. No IndexedDB fallback is used by the product.
export { exportBackup, importBackup } from "./client";
