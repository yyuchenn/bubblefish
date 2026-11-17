use crate::common::CoreResult;

// Storage traits
pub trait Storage<K, V> {
    fn insert(&mut self, key: K, value: V) -> CoreResult<()>;
    fn get(&self, key: &K) -> Option<&V>;
    fn get_mut(&mut self, key: &K) -> Option<&mut V>;
    fn remove(&mut self, key: &K) -> Option<V>;
    fn contains(&self, key: &K) -> bool;
    fn clear(&mut self);
    type Iter<'a>: Iterator<Item = (&'a K, &'a V)> where Self: 'a, K: 'a, V: 'a;
    fn iter(&self) -> Self::Iter<'_>;
}