import { useState } from 'react';
import { View, TouchableOpacity, Text, StyleSheet, Platform } from 'react-native';
import { SafeAreaView, SafeAreaProvider } from 'react-native-safe-area-context';
import ConnectScreen from './src/screens/ConnectScreen';
import HostScreen from './src/screens/HostScreen';
import { WalletProvider } from './src/utils/WalletContext';

export default function App() {
  const [activeTab, setActiveTab] = useState('connect');

  return (
    <SafeAreaProvider>
      <WalletProvider>
        <SafeAreaView style={styles.container} edges={['top']}>
          <View style={styles.main}>
            {activeTab === 'connect' ? <ConnectScreen /> : <HostScreen />}
          </View>

          {/* Tab bar sits above Android nav bar */}
          <View style={[styles.tabBar, Platform.OS === 'android' && styles.tabBarAndroid]}>
            <TouchableOpacity
              style={[styles.tab, activeTab === 'connect' && styles.activeTab]}
              onPress={() => setActiveTab('connect')}
            >
              <Text style={styles.tabIcon}>⚡</Text>
              <Text style={[styles.tabText, activeTab === 'connect' && styles.activeTabText]}>Connect</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[styles.tab, activeTab === 'host' && styles.activeTab]}
              onPress={() => setActiveTab('host')}
            >
              <Text style={styles.tabIcon}>🔥</Text>
              <Text style={[styles.tabText, activeTab === 'host' && styles.activeTabText]}>Host</Text>
            </TouchableOpacity>
          </View>
        </SafeAreaView>
      </WalletProvider>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#050000',
  },
  main: {
    flex: 1,
  },
  tabBar: {
    flexDirection: 'row',
    height: 110,
    backgroundColor: '#111',
    borderTopWidth: 1,
    borderTopColor: '#222',
    paddingBottom: 50,
  },
  tabBarAndroid: {
    paddingBottom: 8,
    height: 110,
    paddingBottom: 50,
  },
  tab: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    opacity: 0.5,
  },
  activeTab: {
    opacity: 1,
  },
  tabIcon: {
    fontSize: 20,
    marginBottom: 2,
  },
  tabText: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '600',
  },
  activeTabText: {
    color: '#ff2a2a',
  },
});
