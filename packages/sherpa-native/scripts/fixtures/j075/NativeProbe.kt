package dev.happier.sherpa.fixture

object NativeProbe {
  init { System.loadLibrary("happier_sherpa_jni") }
  external fun bind(): Boolean
  external fun snapshot(): String
  external fun liveStreams(): Int
  external fun destroyedStreams(): Int
  external fun liveRecognizers(): Int
  external fun ownerCreates(): Int
  external fun ownerDisposals(): Int
  external fun failNextCreate()
  external fun failNextDisposal()
  external fun holdDecode()
  external fun awaitDecode(): Boolean
  external fun releaseDecode()
}
