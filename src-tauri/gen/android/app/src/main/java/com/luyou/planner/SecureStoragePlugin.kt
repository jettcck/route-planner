package com.luyou.planner

import android.app.Activity
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.Plugin
import java.nio.ByteBuffer
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** Small Android Keystore backed vault for API keys and account sessions. */
@TauriPlugin
class SecureStoragePlugin(private val activity: Activity) : Plugin(activity) {
    @InvokeArg
    class ValueArgs {
        lateinit var key: String
        var value: String? = null
    }

    @InvokeArg
    class KeyArgs {
        lateinit var key: String
    }

    @Command
    fun set(invoke: Invoke) {
        try {
            val args = invoke.parseArgs(ValueArgs::class.java)
            validateKey(args.key)
            require(args.value != null) { "secure storage value is missing" }
            require(args.value!!.toByteArray(Charsets.UTF_8).size <= MAX_VALUE_BYTES) { "secure storage value is too large" }
            val encrypted = encrypt(args.value!!)
            // Migration deletes the legacy localStorage value only after this
            // command succeeds. Commit synchronously so a process kill cannot
            // acknowledge the write before it reaches disk.
            check(prefs().edit().putString(args.key, encrypted).commit()) {
                "secure storage write failed"
            }
            invoke.resolve()
        } catch (error: Exception) {
            invoke.reject(error.message ?: "secure storage write failed")
        }
    }

    @Command
    fun get(invoke: Invoke) {
        try {
            val args = invoke.parseArgs(KeyArgs::class.java)
            validateKey(args.key)
            val stored = prefs().getString(args.key, null)
            invoke.resolveObject(mapOf("value" to stored?.let(::decrypt)))
        } catch (error: Exception) {
            invoke.reject(error.message ?: "secure storage read failed")
        }
    }

    @Command
    fun delete(invoke: Invoke) {
        try {
            val args = invoke.parseArgs(KeyArgs::class.java)
            validateKey(args.key)
            check(prefs().edit().remove(args.key).commit()) {
                "secure storage delete failed"
            }
            invoke.resolve()
        } catch (error: Exception) {
            invoke.reject(error.message ?: "secure storage delete failed")
        }
    }

    private fun validateKey(key: String) {
        require(key.matches(Regex("[A-Za-z0-9._-]{1,120}"))) { "invalid secure storage key" }
    }

    private fun prefs() = activity.getSharedPreferences("route_secure_storage", Activity.MODE_PRIVATE)

    @Synchronized
    private fun key(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        val existing = store.getKey(KEY_ALIAS, null)
        if (existing is SecretKey) return existing
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        generator.init(
            KeyGenParameterSpec.Builder(
                KEY_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
            )
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .build(),
        )
        return generator.generateKey()
    }

    private fun encrypt(value: String): String {
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, key())
        val iv = cipher.iv
        val encrypted = cipher.doFinal(value.toByteArray(Charsets.UTF_8))
        val payload = ByteBuffer.allocate(4 + iv.size + encrypted.size)
            .putInt(iv.size)
            .put(iv)
            .put(encrypted)
            .array()
        return Base64.encodeToString(payload, Base64.NO_WRAP)
    }

    private fun decrypt(value: String): String {
        require(value.length <= MAX_ENCRYPTED_VALUE_CHARS) { "invalid secure storage payload" }
        val payload = Base64.decode(value, Base64.NO_WRAP)
        val buffer = ByteBuffer.wrap(payload)
        val ivSize = buffer.int
        require(ivSize in 12..16 && buffer.remaining() > ivSize) { "invalid secure storage payload" }
        val iv = ByteArray(ivSize)
        buffer.get(iv)
        val encrypted = ByteArray(buffer.remaining())
        buffer.get(encrypted)
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, iv))
        return String(cipher.doFinal(encrypted), Charsets.UTF_8)
    }

    private companion object {
        const val KEY_ALIAS = "route-secure-storage-key"
        const val TRANSFORMATION = "AES/GCM/NoPadding"
        const val MAX_VALUE_BYTES = 512 * 1024
        const val MAX_ENCRYPTED_VALUE_CHARS = 1_000_000
    }
}
