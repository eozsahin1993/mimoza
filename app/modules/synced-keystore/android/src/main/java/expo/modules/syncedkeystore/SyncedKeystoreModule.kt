package expo.modules.syncedkeystore

import com.google.android.gms.auth.blockstore.Blockstore
import com.google.android.gms.auth.blockstore.DeleteBytesRequest
import com.google.android.gms.auth.blockstore.RetrieveBytesRequest
import com.google.android.gms.auth.blockstore.StoreBytesData
import com.google.android.gms.tasks.Task
import expo.modules.kotlin.functions.Coroutine
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import kotlinx.coroutines.suspendCancellableCoroutine

/**
 * A missing key (retrieveBytes succeeding with nothing in the map) and a
 * genuine failure (no Play Services, a transient Blockstore error) are
 * deliberately not the same outcome here: get/set/delete all throw on
 * failure rather than swallow it, matching the iOS module's contract.
 * The caller — not yet written; see account-keypair.ts — is what should
 * decide what a failure means, and it can't do that if this layer has
 * already reported it as "nothing stored."
 */
class SyncedKeystoreModule : Module() {
  private val context
    get() = requireNotNull(appContext.reactContext) {
      "React Application Context is null"
    }

  override fun definition() = ModuleDefinition {
    Name("SyncedKeystore")

    AsyncFunction("setSynced") Coroutine { key: String, value: String ->
      val client = Blockstore.getClient(context)
      // Read fresh on every call, never cached: an unset/false flag on ANY
      // write drops a previously cloud-backed copy on the next periodic
      // sync, so this must reflect current device capability every time.
      val e2e = client.isEndToEndEncryptionAvailable().awaitResult()
      val data = StoreBytesData.Builder()
        .setBytes(value.toByteArray(Charsets.UTF_8))
        .setKey(key)
        .setShouldBackupToCloud(e2e)
        .build()
      client.storeBytes(data).awaitResult()
      Unit
    }

    AsyncFunction("getSynced") Coroutine { key: String ->
      val client = Blockstore.getClient(context)
      val request = RetrieveBytesRequest.Builder().setKeys(listOf(key)).build()
      val response = client.retrieveBytes(request).awaitResult()
      response.blockstoreDataMap[key]?.bytes?.toString(Charsets.UTF_8)
    }

    AsyncFunction("deleteSynced") Coroutine { key: String ->
      val client = Blockstore.getClient(context)
      val request = DeleteBytesRequest.Builder().setKeys(listOf(key)).build()
      client.deleteBytes(request).awaitResult()
      Unit
    }
  }
}

// Task<T>.await() needs kotlinx-coroutines-play-services, not a confirmed
// existing dependency here — this local bridge avoids adding one for a
// single call site.
private suspend fun <T> Task<T>.awaitResult(): T = suspendCancellableCoroutine { cont ->
  addOnSuccessListener { cont.resume(it) }
  addOnFailureListener { cont.resumeWithException(it) }
}
