"""The CloudKit types abridge-reminders uses: records in a changes feed or a
lookup, and the request side of records/modify."""

from types import SimpleNamespace


class CKRecord(SimpleNamespace):
    pass


class CKTombstoneRecord(SimpleNamespace):
    pass


class CKErrorItem(SimpleNamespace):
    pass


class CKWriteRecord(SimpleNamespace):
    pass


class CKModifyOperation(SimpleNamespace):
    pass


class CKFields(dict):
    """Like pyicloud's: fields by name, each with a .value."""

    def get_value(self, key):
        field = self.get(key)
        return None if field is None else field.value
