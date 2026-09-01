#define _DARWIN_C_SOURCE

#include <errno.h>
#include <fcntl.h>
#include <node_api.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/file.h>
#include <sys/mount.h>
#include <sys/stat.h>
#include <unistd.h>
#include <dirent.h>

static void throw_errno(napi_env env, const char *syscall) {
  int code = errno;
  const char *name = strerror(code);
  char message[256];
  snprintf(message, sizeof(message), "%s failed: %s", syscall, name);
  napi_value error;
  napi_create_error(env, NULL, NULL, &error);
  napi_value code_value;
  napi_create_string_utf8(env, name, NAPI_AUTO_LENGTH, &code_value);
  napi_set_named_property(env, error, "code", code_value);
  napi_value errno_value;
  napi_create_int32(env, code, &errno_value);
  napi_set_named_property(env, error, "errno", errno_value);
  napi_value syscall_value;
  napi_create_string_utf8(env, syscall, NAPI_AUTO_LENGTH, &syscall_value);
  napi_set_named_property(env, error, "syscall", syscall_value);
  napi_value message_value;
  napi_create_string_utf8(env, message, NAPI_AUTO_LENGTH, &message_value);
  napi_set_named_property(env, error, "message", message_value);
  napi_throw(env, error);
}

static bool get_int32_arg(napi_env env, napi_value value, int32_t *out) {
  return napi_get_value_int32(env, value, out) == napi_ok;
}

static bool get_path_arg(napi_env env, napi_value value, char **out) {
  size_t length = 0;
  if (napi_get_value_string_utf8(env, value, NULL, 0, &length) != napi_ok) return false;
  char *buffer = malloc(length + 1);
  if (!buffer) return false;
  if (napi_get_value_string_utf8(env, value, buffer, length + 1, &length) != napi_ok) {
    free(buffer);
    return false;
  }
  *out = buffer;
  return true;
}

static napi_value stat_to_object(napi_env env, const struct stat *info) {
  napi_value object;
  napi_create_object(env, &object);
  napi_value value;
  napi_create_bigint_uint64(env, (uint64_t)info->st_dev, &value);
  napi_set_named_property(env, object, "dev", value);
  napi_create_bigint_uint64(env, (uint64_t)info->st_ino, &value);
  napi_set_named_property(env, object, "ino", value);
  napi_create_uint32(env, (uint32_t)info->st_mode, &value);
  napi_set_named_property(env, object, "mode", value);
  napi_create_uint32(env, (uint32_t)info->st_uid, &value);
  napi_set_named_property(env, object, "uid", value);
  napi_create_uint32(env, (uint32_t)info->st_nlink, &value);
  napi_set_named_property(env, object, "nlink", value);
  napi_create_bigint_int64(env, (int64_t)info->st_size, &value);
  napi_set_named_property(env, object, "size", value);
  napi_value type;
  if (S_ISREG(info->st_mode)) napi_create_string_utf8(env, "file", NAPI_AUTO_LENGTH, &type);
  else if (S_ISDIR(info->st_mode)) napi_create_string_utf8(env, "directory", NAPI_AUTO_LENGTH, &type);
  else if (S_ISLNK(info->st_mode)) napi_create_string_utf8(env, "symlink", NAPI_AUTO_LENGTH, &type);
  else napi_create_string_utf8(env, "other", NAPI_AUTO_LENGTH, &type);
  napi_set_named_property(env, object, "type", type);
  return object;
}

static napi_value js_fstatat(napi_env env, napi_callback_info cb) {
  size_t argc = 2;
  napi_value args[2];
  napi_get_cb_info(env, cb, &argc, args, NULL, NULL);
  int32_t root_fd;
  char *name;
  if (argc < 2 || !get_int32_arg(env, args[0], &root_fd) || !get_path_arg(env, args[1], &name)) {
    napi_throw_type_error(env, NULL, "fstatat requires fd and name");
    return NULL;
  }
  struct stat info;
  int result = fstatat(root_fd, name, &info, AT_SYMLINK_NOFOLLOW);
  free(name);
  if (result != 0) {
    if (errno == ENOENT) {
      napi_value null_value;
      napi_get_null(env, &null_value);
      return null_value;
    }
    throw_errno(env, "fstatat");
    return NULL;
  }
  return stat_to_object(env, &info);
}

static napi_value js_fstat(napi_env env, napi_callback_info cb) {
  size_t argc = 1;
  napi_value args[1];
  napi_get_cb_info(env, cb, &argc, args, NULL, NULL);
  int32_t fd;
  if (argc < 1 || !get_int32_arg(env, args[0], &fd)) {
    napi_throw_type_error(env, NULL, "fstat requires fd");
    return NULL;
  }
  struct stat info;
  if (fstat(fd, &info) != 0) {
    throw_errno(env, "fstat");
    return NULL;
  }
  return stat_to_object(env, &info);
}

static napi_value js_openat(napi_env env, napi_callback_info cb) {
  size_t argc = 4;
  napi_value args[4];
  napi_get_cb_info(env, cb, &argc, args, NULL, NULL);
  int32_t root_fd, flags, mode;
  char *name;
  if (argc < 3 || !get_int32_arg(env, args[0], &root_fd) || !get_path_arg(env, args[1], &name) ||
      !get_int32_arg(env, args[2], &flags)) {
    napi_throw_type_error(env, NULL, "openat requires fd, name, flags, and optional mode");
    return NULL;
  }
  mode = 0;
  if (argc >= 4) get_int32_arg(env, args[3], &mode);
  int fd = openat(root_fd, name, flags, (mode_t)mode);
  free(name);
  if (fd < 0) {
    if (errno == ENOENT) {
      napi_value null_value;
      napi_get_null(env, &null_value);
      return null_value;
    }
    throw_errno(env, "openat");
    return NULL;
  }
  napi_value value;
  napi_create_int32(env, fd, &value);
  return value;
}

static napi_value js_read(napi_env env, napi_callback_info cb) {
  size_t argc = 2;
  napi_value args[2];
  napi_get_cb_info(env, cb, &argc, args, NULL, NULL);
  int32_t fd, limit;
  if (argc < 2 || !get_int32_arg(env, args[0], &fd) || !get_int32_arg(env, args[1], &limit) || limit < 0) {
    napi_throw_type_error(env, NULL, "read requires fd and non-negative limit");
    return NULL;
  }
  char *buffer = malloc((size_t)limit);
  if (!buffer) {
    napi_throw_error(env, NULL, "allocation failed");
    return NULL;
  }
  ssize_t total = 0;
  while (total < limit) {
    ssize_t count = pread(fd, buffer + total, (size_t)(limit - total), (off_t)total);
    if (count < 0) {
      free(buffer);
      throw_errno(env, "pread");
      return NULL;
    }
    if (count == 0) break;
    total += count;
  }
  napi_value result;
  napi_create_buffer_copy(env, (size_t)total, buffer, NULL, &result);
  free(buffer);
  return result;
}

static napi_value js_write_all(napi_env env, napi_callback_info cb) {
  size_t argc = 2;
  napi_value args[2];
  napi_get_cb_info(env, cb, &argc, args, NULL, NULL);
  int32_t fd;
  void *data;
  size_t length;
  if (argc < 2 || !get_int32_arg(env, args[0], &fd) || napi_get_buffer_info(env, args[1], &data, &length) != napi_ok) {
    napi_throw_type_error(env, NULL, "writeAll requires fd and buffer");
    return NULL;
  }
  size_t total = 0;
  while (total < length) {
    ssize_t count = write(fd, (char *)data + total, length - total);
    if (count <= 0) {
      if (count == 0) errno = EIO;
      throw_errno(env, "write");
      return NULL;
    }
    total += (size_t)count;
  }
  napi_value undefined;
  napi_get_undefined(env, &undefined);
  return undefined;
}

static napi_value js_close(napi_env env, napi_callback_info cb) {
  size_t argc = 1;
  napi_value args[1];
  napi_get_cb_info(env, cb, &argc, args, NULL, NULL);
  int32_t fd;
  if (argc < 1 || !get_int32_arg(env, args[0], &fd)) {
    napi_throw_type_error(env, NULL, "close requires fd");
    return NULL;
  }
  if (close(fd) != 0) {
    throw_errno(env, "close");
    return NULL;
  }
  napi_value undefined;
  napi_get_undefined(env, &undefined);
  return undefined;
}

static napi_value js_fsync(napi_env env, napi_callback_info cb) {
  size_t argc = 1;
  napi_value args[1];
  napi_get_cb_info(env, cb, &argc, args, NULL, NULL);
  int32_t fd;
  if (argc < 1 || !get_int32_arg(env, args[0], &fd)) {
    napi_throw_type_error(env, NULL, "fsync requires fd");
    return NULL;
  }
  if (fsync(fd) != 0) {
    throw_errno(env, "fsync");
    return NULL;
  }
  napi_value undefined;
  napi_get_undefined(env, &undefined);
  return undefined;
}

static napi_value js_renameat(napi_env env, napi_callback_info cb) {
  size_t argc = 4;
  napi_value args[4];
  napi_get_cb_info(env, cb, &argc, args, NULL, NULL);
  int32_t from_fd, to_fd;
  char *from_name, *to_name;
  if (argc < 4 || !get_int32_arg(env, args[0], &from_fd) || !get_path_arg(env, args[1], &from_name) ||
      !get_int32_arg(env, args[2], &to_fd) || !get_path_arg(env, args[3], &to_name)) {
    napi_throw_type_error(env, NULL, "renameat requires from fd/name and to fd/name");
    return NULL;
  }
  int result = renameat(from_fd, from_name, to_fd, to_name);
  free(from_name);
  free(to_name);
  if (result != 0) {
    throw_errno(env, "renameat");
    return NULL;
  }
  napi_value undefined;
  napi_get_undefined(env, &undefined);
  return undefined;
}

static napi_value js_unlinkat(napi_env env, napi_callback_info cb) {
  size_t argc = 2;
  napi_value args[2];
  napi_get_cb_info(env, cb, &argc, args, NULL, NULL);
  int32_t root_fd;
  char *name;
  if (argc < 2 || !get_int32_arg(env, args[0], &root_fd) || !get_path_arg(env, args[1], &name)) {
    napi_throw_type_error(env, NULL, "unlinkat requires fd and name");
    return NULL;
  }
  int result = unlinkat(root_fd, name, 0);
  free(name);
  if (result != 0) {
    throw_errno(env, "unlinkat");
    return NULL;
  }
  napi_value undefined;
  napi_get_undefined(env, &undefined);
  return undefined;
}

static napi_value js_readdir(napi_env env, napi_callback_info cb) {
  size_t argc = 1;
  napi_value args[1];
  napi_get_cb_info(env, cb, &argc, args, NULL, NULL);
  int32_t root_fd;
  if (argc < 1 || !get_int32_arg(env, args[0], &root_fd)) {
    napi_throw_type_error(env, NULL, "readdir requires fd");
    return NULL;
  }
  int fd = openat(root_fd, ".", O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
  if (fd < 0) {
    throw_errno(env, "openat");
    return NULL;
  }
  DIR *directory = fdopendir(fd);
  if (!directory) {
    close(fd);
    throw_errno(env, "fdopendir");
    return NULL;
  }
  napi_value array;
  napi_create_array(env, &array);
  uint32_t index = 0;
  errno = 0;
  for (;;) {
    struct dirent *entry = readdir(directory);
    if (!entry) break;
    if (strcmp(entry->d_name, ".") == 0 || strcmp(entry->d_name, "..") == 0) continue;
    napi_value name;
    napi_create_string_utf8(env, entry->d_name, NAPI_AUTO_LENGTH, &name);
    napi_set_element(env, array, index++, name);
  }
  int saved = errno;
  closedir(directory);
  if (saved != 0) {
    errno = saved;
    throw_errno(env, "readdir");
    return NULL;
  }
  return array;
}

static napi_value js_is_local(napi_env env, napi_callback_info cb) {
  size_t argc = 1;
  napi_value args[1];
  napi_get_cb_info(env, cb, &argc, args, NULL, NULL);
  int32_t fd;
  if (argc < 1 || !get_int32_arg(env, args[0], &fd)) {
    napi_throw_type_error(env, NULL, "isLocalFileSystem requires fd");
    return NULL;
  }
  struct statfs info;
  if (fstatfs(fd, &info) != 0) {
    throw_errno(env, "fstatfs");
    return NULL;
  }
  napi_value result;
  napi_get_boolean(env, (info.f_flags & MNT_LOCAL) != 0, &result);
  return result;
}

static napi_value js_try_flock(napi_env env, napi_callback_info cb) {
  size_t argc = 1;
  napi_value args[1];
  napi_get_cb_info(env, cb, &argc, args, NULL, NULL);
  int32_t fd;
  if (argc < 1 || !get_int32_arg(env, args[0], &fd)) {
    napi_throw_type_error(env, NULL, "tryExclusive requires fd");
    return NULL;
  }
  int result = flock(fd, LOCK_EX | LOCK_NB);
  napi_value value;
  if (result == 0) {
    napi_create_string_utf8(env, "acquired", NAPI_AUTO_LENGTH, &value);
    return value;
  }
  if (errno == EWOULDBLOCK || errno == EAGAIN) {
    napi_create_string_utf8(env, "contended", NAPI_AUTO_LENGTH, &value);
    return value;
  }
  throw_errno(env, "flock");
  return NULL;
}

static napi_value js_unlock(napi_env env, napi_callback_info cb) {
  size_t argc = 1;
  napi_value args[1];
  napi_get_cb_info(env, cb, &argc, args, NULL, NULL);
  int32_t fd;
  if (argc < 1 || !get_int32_arg(env, args[0], &fd)) {
    napi_throw_type_error(env, NULL, "unlock requires fd");
    return NULL;
  }
  if (flock(fd, LOCK_UN) != 0) {
    throw_errno(env, "flock");
    return NULL;
  }
  napi_value undefined;
  napi_get_undefined(env, &undefined);
  return undefined;
}

static napi_value init(napi_env env, napi_value exports) {
  napi_property_descriptor descriptors[] = {
    {"fstat", 0, js_fstat, 0, 0, 0, napi_default, 0},
    {"fstatat", 0, js_fstatat, 0, 0, 0, napi_default, 0},
    {"openat", 0, js_openat, 0, 0, 0, napi_default, 0},
    {"read", 0, js_read, 0, 0, 0, napi_default, 0},
    {"writeAll", 0, js_write_all, 0, 0, 0, napi_default, 0},
    {"close", 0, js_close, 0, 0, 0, napi_default, 0},
    {"fsync", 0, js_fsync, 0, 0, 0, napi_default, 0},
    {"renameat", 0, js_renameat, 0, 0, 0, napi_default, 0},
    {"unlinkat", 0, js_unlinkat, 0, 0, 0, napi_default, 0},
    {"readdir", 0, js_readdir, 0, 0, 0, napi_default, 0},
    {"isLocalFileSystem", 0, js_is_local, 0, 0, 0, napi_default, 0},
    {"tryExclusive", 0, js_try_flock, 0, 0, 0, napi_default, 0},
    {"unlock", 0, js_unlock, 0, 0, 0, napi_default, 0},
  };
  napi_define_properties(env, exports, sizeof(descriptors) / sizeof(descriptors[0]), descriptors);
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, init)
