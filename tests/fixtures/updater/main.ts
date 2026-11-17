import { mount } from 'svelte';
import UpdaterFixture from './UpdaterFixture.svelte';
import '../../../src/styles.css';

mount(UpdaterFixture, { target: document.getElementById('app')! });
