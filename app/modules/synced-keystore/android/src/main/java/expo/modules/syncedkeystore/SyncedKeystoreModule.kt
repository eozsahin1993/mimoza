package expo.modules.syncedkeystore

import android.util.Log
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

private const val TAG = "SyncedKeystore"

/**
 * A missing key (retrieveBytes succeeding with nothing in the map) and a
 * genuine failure (no Play Services, a transient Blockstore error) are
 * deliberately not the same outcome here: get/set/delete all throw on
 * failure rather than swallow it, matching the iOS module's contract.
 * The caller (synced-store.ts) is what should decide what a failure
 * means, and it can't do that if this layer has already reported it as
 * "nothing stored."
 */
class SyncedKeystoreModule : Module() {
  private val context
    get() = requireNotNull(appContext.reactContext) {
      "React Application Context is null"
    }

  override fun definition() = ModuleDefinition {
    Name("SyncedKeystore")

    AsyncFunction("setSynced") Coroutine { key: String, value: String ->
      try {
        val client = Blockstore.getClient(context)
        // Read fresh on every call, never cached: an unset/false flag on ANY
        // write drops a previously cloud-backed copy on the next periodic
        // sync, so this must reflect current device capability every time.
        val e2e = client.isEndToEndEncryptionAvailable().awaitResult()
        val builder = StoreBytesData.Builder()
          .setBytes(value.toByteArray(Charsets.UTF_8))
          .setKey(key)
        // An explicit false here (vs. never calling this) measurably broke
        // local retrieval in testing, even same-device same-process —
        // undocumented, but confirmed live. Only call this to opt in.
        if (e2e) builder.setShouldBackupToCloud(true)
        client.storeBytes(builder.build()).awaitResult()
        Log.i(TAG, "setSynced($key): written, backedUpToCloud=$e2e")
        value
      } catch (e: Throwable) {
        Log.w(TAG, "setSynced($key) failed", e)
        throw e
      }
    }

    AsyncFunction("getSynced") Coroutine { key: String ->
      try {
        val client = Blockstore.getClient(context)
        val request = RetrieveBytesRequest.Builder().setKeys(listOf(key)).build()
        val response = client.retrieveBytes(request).awaitResult()
        // No trickle-in delay to race, unlike iCloud Keychain: a miss here
        // is a confirmed answer, restored (or not) at install time.
        val value = response.blockstoreDataMap[key]?.bytes?.toString(Charsets.UTF_8)
        Log.i(TAG, "getSynced($key): ${if (value != null) "found" else "not found"}")
        value
      } catch (e: Throwable) {
        Log.w(TAG, "getSynced($key) failed", e)
        throw e
      }
    }

    AsyncFunction("deleteSynced") Coroutine { key: String ->
      try {
        val client = Blockstore.getClient(context)
        val request = DeleteBytesRequest.Builder().setKeys(listOf(key)).build()
        client.deleteBytes(request).awaitResult()
        Log.i(TAG, "deleteSynced($key): done")
      } catch (e: Throwable) {
        Log.w(TAG, "deleteSynced($key) failed", e)
        throw e
      }
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
