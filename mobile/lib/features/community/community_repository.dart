import 'dart:math';
import 'dart:convert';
import '../../core/api_client.dart';

String communityRequestKey() {
  final random = Random.secure();
  final bytes = List<int>.generate(16, (_) => random.nextInt(256));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  final hex = bytes.map((b) => b.toRadixString(16).padLeft(2, '0')).join();
  return '${hex.substring(0, 8)}-${hex.substring(8, 12)}-${hex.substring(12, 16)}-${hex.substring(16, 20)}-${hex.substring(20)}';
}

class CommunityRepository {
  CommunityRepository(this.api);
  final ApiClient api;
  final Map<String, String> _pendingKeys = {};
  Future<dynamic> get(String path) => api.request('/api/community$path');
  Future<dynamic> send(
    String path,
    Map<String, dynamic> body, {
    String? key,
  }) async {
    final fingerprint = jsonEncode([path, body]);
    final requestKey = _pendingKeys.putIfAbsent(
      fingerprint,
      () => key ?? communityRequestKey(),
    );
    final result = await api.request(
      '/api/community$path',
      method: 'POST',
      body: {...body, 'requestKey': requestKey},
      timeout: const Duration(seconds: 60),
    );
    _pendingKeys.remove(fingerprint);
    return result;
  }

  Future<void> enrol(String version) async {
    await api.request(
      '/api/community/enrol',
      method: 'POST',
      body: {'noticeVersion': version},
    );
  }
}
